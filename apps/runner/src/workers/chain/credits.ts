import { dec, prisma, type CreditFunding } from "@pyre/db";
import { MIN_CREDITS_FUNDING_USD, weiFromUsdMicros } from "@pyre/shared";
import { getEthBalance, getEthPriceUsd, publicClient, sendTx, treasury, TransactionRevertedError } from "@pyre/chain";
import { Worker } from "bullmq";
import type { Logger } from "pino";
import { getAddress, type Hex } from "viem";
import { audit } from "../../lib/audit.js";
import { withLock } from "../../lib/lock.js";
import { getRelayIntent, quoteEthToUsdc, waitForRelayFill, RelayQuoteError } from "../../lib/relay.js";
import { getZentroDepositAddress, maskAddress, ZENTRO_SESSION_EXPIRED } from "../../lib/zentro.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { chainWorkerEnv } from "./env.js";
import { isPaused } from "./money.js";
import { TREASURY_FLOOR_WEI } from "./wallet.js";

/*
 * Model-credit funding. Each coin's `CREDITS:<appId>` ledger balance is its accrued, unfunded
 * share of creator fees earmarked for the card that pays Anthropic (the founder's Zentro card, set
 * as Anthropic's billing method with auto-reload). With ZENTRO_STATE set, every coin whose balance
 * clears MIN_CREDITS_FUNDING_USD is topped up from the treasury, at most MAX_CREDITS_FUNDING_USD
 * per top-up, through a persisted step machine on `CreditFunding`:
 *
 *   ADDRESS_MINTED  a headless Zentro session minted a fresh USDC (Ethereum) deposit address for
 *                   the whole-dollar amount; nothing has left the treasury.
 *   SENT            Relay quoted ETH (Robinhood Chain) → exactly that many USDC on Ethereum to the
 *                   address, the quote passed the sanity checks, and the treasury sent the single
 *                   origin transaction. `relayRequestId`, `ethWei`, `usdcUnits` are written BEFORE
 *                   the broadcast and `sendTx` in the same tick as it, so a crash resumes here.
 *   CONFIRMED       Relay reports the destination fill; `fillTx` is the Ethereum transaction and
 *                   the `CREDITS:<appId>` ledger is debited in the same DB transaction.
 *   FAILED          nothing moved (quote refused, revert, address expired) or Relay refunded /
 *                   failed the fill — the balance stays on the ledger for the next pass.
 *
 * A pass first resumes every in-flight row (SENT → poll the intent; ADDRESS_MINTED → send, or
 * abandon when the address is stale), then opens new top-ups for coins with nothing in flight.
 * `zentro_session_expired` is persisted on the `credits_funding` PlatformSetting (the ops page
 * raises ZENTRO_SESSION_EXPIRED from it) and funding backs off for ZENTRO_SESSION_BACKOFF_MS. With
 * ZENTRO_STATE unset the same setting says `accrue_only` and credits simply keep accruing.
 * Deposit addresses and the session are never logged in full.
 */

/** Ceiling on a single card top-up, whatever a coin has accrued; the remainder waits for the next pass. */
export const MAX_CREDITS_FUNDING_USD = 250;
/** PlatformSetting key describing the funding mode to the API/ops page. */
export const CREDITS_FUNDING_SETTING = "credits_funding";
/** After a session failure, no Zentro attempt for this long — every attempt costs a headless browser run. */
export const ZENTRO_SESSION_BACKOFF_MS = 6 * 3_600_000;
/** A minted, unsent address older than this is abandoned: Zentro rotates addresses per top-up and may stop watching a stale one. */
export const ADDRESS_TTL_MS = 30 * 60_000;
/** Relay fills land in seconds; the pass that sent keeps polling up to this long. */
export const FILL_DEADLINE_MS = 15 * 60_000;
/** A later pass resuming a SENT row gives the intent at least this long before handing it on again. */
const RESUME_POLL_MS = 60_000;
/** Margin over the spot ETH price for the affordability check done before minting an address. */
const PRE_QUOTE_MARGIN_BPS = 500n;

export interface CreditsFundingStatus {
  mode: "accrue_only" | "zentro";
  /** ISO time of the last `zentro_session_expired`; null once a later mint succeeds. */
  sessionExpiredAt: string | null;
  updatedAt: string;
}

const readStatus = async (): Promise<CreditsFundingStatus | null> => {
  const row = await prisma.platformSetting.findUnique({ where: { key: CREDITS_FUNDING_SETTING } });
  const v = row?.value;
  return v && typeof v === "object" && !Array.isArray(v) && "mode" in v ? (v as unknown as CreditsFundingStatus) : null;
};

const writeStatus = async (next: Omit<CreditsFundingStatus, "updatedAt">): Promise<void> => {
  const value = { ...next, updatedAt: new Date().toISOString() };
  await prisma.platformSetting.upsert({ where: { key: CREDITS_FUNDING_SETTING }, create: { key: CREDITS_FUNDING_SETTING, value }, update: { value } });
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

const fail = async (row: CreditFunding, error: string): Promise<void> => {
  await prisma.creditFunding.update({ where: { id: row.id }, data: { status: "FAILED", error } });
};

/** Polls Relay for a SENT row and settles it: CONFIRMED + ledger debit, FAILED on refund/failure, or left SENT on timeout. */
async function settleSent(row: CreditFunding, log: Logger, now: number): Promise<void> {
  const requestId = row.relayRequestId as Hex | null;
  if (!requestId) {
    await prisma.creditFunding.update({ where: { id: row.id }, data: { error: "SENT without relayRequestId; reconcile by hand" } });
    log.error({ fundingId: row.id }, "credit funding SENT without a Relay request id");
    return;
  }
  const deadline = Math.max(row.createdAt.getTime() + FILL_DEADLINE_MS, now + RESUME_POLL_MS);
  const fill = await waitForRelayFill(requestId, deadline);
  const to = maskAddress(row.wallet);
  if (fill.outcome === "success") {
    await prisma.$transaction([
      prisma.creditFunding.update({ where: { id: row.id }, data: { status: "CONFIRMED", fillTx: fill.fillTx, error: null, completedAt: new Date() } }),
      prisma.ledgerEntry.create({ data: { account: `CREDITS:${row.appId}`, deltaMicros: -row.usdMicros, refType: "CreditFunding", refId: row.id, memo: "card top-up" } }),
    ]);
    log.info({ appId: row.appId, fundingId: row.id, usdMicros: row.usdMicros.toString(), usdcUnits: row.usdcUnits.toString(), sendTx: row.sendTx, fillTx: fill.fillTx, to }, "coin credits funded");
    await audit({
      actor: "worker:credits",
      action: "CREDIT_FUNDING",
      targetType: "CreditFunding",
      targetId: row.id,
      meta: { appId: row.appId, usdMicros: row.usdMicros, ethWei: row.ethWei.toString(), usdcUnits: row.usdcUnits, sendTx: row.sendTx, fillTx: fill.fillTx, to, relayRequestId: requestId },
    });
    return;
  }
  if (fill.outcome === "timeout") {
    await prisma.creditFunding.update({ where: { id: row.id }, data: { error: `relay fill unconfirmed (status ${fill.status}); ETH is with Relay, row kept SENT` } });
    log.warn({ appId: row.appId, fundingId: row.id, sendTx: row.sendTx, status: fill.status }, "relay fill not confirmed yet; will poll again next pass");
    return;
  }
  const error = fill.outcome === "refund" ? "relay refunded the deposit to the treasury" : "relay reported failure; verify the treasury balance";
  await fail(row, error);
  log.error({ appId: row.appId, fundingId: row.id, sendTx: row.sendTx, outcome: fill.outcome }, "credit funding failed at Relay; balance left for next pass");
}

/**
 * Quotes and sends the single origin transaction for an ADDRESS_MINTED row, then settles it.
 * Returns without sending when the treasury cannot afford the quote (the row waits, within its
 * TTL). Resolves `true` only when the row was abandoned as stale, i.e. its coin is free for a fresh
 * address in the same pass.
 */
async function sendForRow(row: CreditFunding, log: Logger, now: number): Promise<boolean> {
  const t = treasury();
  const to = maskAddress(row.wallet);
  if (row.relayRequestId) {
    // A previous pass persisted the intent and then died around the broadcast. If Relay has seen the
    // deposit the money is in flight: adopt it as SENT rather than sending again.
    const intent = await getRelayIntent(row.relayRequestId as Hex);
    if (intent.status !== "unknown") {
      log.warn({ appId: row.appId, fundingId: row.id, status: intent.status }, "relay already saw the deposit of an ADDRESS_MINTED row; adopting as SENT");
      const adopted = await prisma.creditFunding.update({ where: { id: row.id }, data: { status: "SENT", sendTx: intent.inTxHashes[0] ?? null, error: null } });
      await settleSent(adopted, log, now);
      return false;
    }
  }
  if (now - row.createdAt.getTime() > ADDRESS_TTL_MS) {
    // Zentro rotates addresses per top-up and may stop watching a stale one; only an address Relay
    // has not been paid to is abandoned. Returns true so the coin gets a fresh address this pass.
    await fail(row, "deposit address expired before send");
    log.warn({ appId: row.appId, fundingId: row.id, to }, "stale deposit address abandoned");
    return true;
  }
  let quote;
  try {
    quote = await quoteEthToUsdc(t.address, getAddress(row.wallet), row.usdMicros);
  } catch (err) {
    if (!(err instanceof RelayQuoteError)) throw err;
    await fail(row, `quote refused: ${errorText(err)}`);
    log.error({ err, appId: row.appId, fundingId: row.id, to }, "relay quote refused; credit funding failed");
    return false;
  }
  const treasuryWei = await getEthBalance(t.address);
  if (treasuryWei - quote.ethWei < TREASURY_FLOOR_WEI) {
    log.warn({ appId: row.appId, fundingId: row.id, ethWei: quote.ethWei.toString(), treasuryWei: treasuryWei.toString() }, "treasury ETH too low for the quote; top-up waits");
    return false;
  }
  // The intent is on the row before the broadcast: a crash in between is recovered above.
  await prisma.creditFunding.update({
    where: { id: row.id },
    data: { relayRequestId: quote.requestId, ethWei: dec(quote.ethWei), usdcUnits: quote.usdcUnits, error: null },
  });
  let sent: CreditFunding | undefined;
  try {
    await sendTx(
      t.account,
      async (wallet) => {
        const hash = await wallet.sendTransaction({ to: quote.tx.to, data: quote.tx.data, value: quote.tx.value, gas: quote.tx.gas });
        sent = await prisma.creditFunding.update({ where: { id: row.id }, data: { status: "SENT", sendTx: hash } });
        return hash;
      },
      publicClient(),
    );
  } catch (err) {
    if (err instanceof TransactionRevertedError) {
      await fail(row, `relay deposit reverted: ${err.hash}`);
      log.error({ err, appId: row.appId, fundingId: row.id }, "relay deposit reverted; nothing moved");
      return false;
    }
    if (!sent) throw err;
    // Broadcast but receipt unreadable: Relay's status is the source of truth from here.
    log.warn({ err, appId: row.appId, fundingId: row.id, sendTx: sent.sendTx }, "relay deposit receipt unavailable; settling from Relay status");
  }
  if (!sent) throw new Error("sendTx returned without broadcasting");
  log.info({ appId: row.appId, fundingId: row.id, ethWei: quote.ethWei.toString(), usdcUnits: quote.usdcUnits.toString(), costUsd: quote.amountInUsd, sendTx: sent.sendTx, to }, "relay deposit sent");
  await settleSent(sent, log, now);
  return false;
}

/** One funding pass; `now` is injectable for tests. */
export async function fundCredits(log: Logger, now = Date.now()): Promise<void> {
  const state = chainWorkerEnv().ZENTRO_STATE;
  const status = await readStatus();
  if (!state) {
    if (status?.mode !== "accrue_only") {
      await writeStatus({ mode: "accrue_only", sessionExpiredAt: null });
      log.info("ZENTRO_STATE unset; credits accrue on the ledger only");
    }
    return;
  }
  const expiredAt = status?.sessionExpiredAt ? Date.parse(status.sessionExpiredAt) : null;
  if (expiredAt !== null && now - expiredAt < ZENTRO_SESSION_BACKOFF_MS) {
    log.warn({ sessionExpiredAt: status?.sessionExpiredAt }, "zentro session expired; credit funding backed off");
    return;
  }
  if (status?.mode !== "zentro") await writeStatus({ mode: "zentro", sessionExpiredAt: status?.sessionExpiredAt ?? null });

  const inflight = await prisma.creditFunding.findMany({ where: { status: { in: ["ADDRESS_MINTED", "SENT"] } }, orderBy: { createdAt: "asc" } });
  const busy = new Set<string>();
  for (const row of inflight) {
    busy.add(row.appId);
    try {
      if (row.status === "SENT") await settleSent(row, log, now);
      else if (await sendForRow(row, log, now)) busy.delete(row.appId);
    } catch (err) {
      log.error({ err, appId: row.appId, fundingId: row.id, status: row.status }, "credit funding resume failed");
    }
  }

  const minMicros = BigInt(MIN_CREDITS_FUNDING_USD) * 1_000_000n;
  const balances = await prisma.ledgerEntry.groupBy({ by: ["account"], where: { account: { startsWith: "CREDITS:" } }, _sum: { deltaMicros: true } });
  const due = balances
    .map((b) => ({ appId: b.account.slice("CREDITS:".length), pending: b._sum.deltaMicros ?? 0n }))
    .filter((x) => x.pending >= minMicros && !busy.has(x.appId));
  if (due.length === 0) return;

  const t = treasury();
  const ethPriceUsd = await getEthPriceUsd();
  for (const { appId, pending } of due) {
    const topUpUsd = Math.min(MAX_CREDITS_FUNDING_USD, Number(pending / 1_000_000n));
    const usdMicros = BigInt(topUpUsd) * 1_000_000n;
    // Rough affordability before spending a headless-browser run on an address we could not fund.
    const estimateWei = (weiFromUsdMicros(usdMicros, ethPriceUsd) * (10_000n + PRE_QUOTE_MARGIN_BPS)) / 10_000n;
    const treasuryWei = await getEthBalance(t.address);
    if (treasuryWei - estimateWei < TREASURY_FLOOR_WEI) {
      log.warn({ appId, topUpUsd, estimateWei: estimateWei.toString(), treasuryWei: treasuryWei.toString() }, "treasury ETH too low to fund credits; stopping this pass");
      return;
    }
    let deposit;
    try {
      deposit = await getZentroDepositAddress(state, topUpUsd);
    } catch (err) {
      if (errorText(err) === ZENTRO_SESSION_EXPIRED) {
        await writeStatus({ mode: "zentro", sessionExpiredAt: new Date(now).toISOString() });
        log.error({ backoffMs: ZENTRO_SESSION_BACKOFF_MS }, "zentro session expired; re-capture ZENTRO_STATE (ops alert ZENTRO_SESSION_EXPIRED)");
        return;
      }
      log.error({ err, appId, topUpUsd }, "zentro deposit-address flow failed; balance left for next pass");
      continue;
    }
    if (status?.sessionExpiredAt) await writeStatus({ mode: "zentro", sessionExpiredAt: null });
    const row = await prisma.creditFunding.create({
      data: { appId, usdMicros: BigInt(deposit.amountUsd) * 1_000_000n, wallet: deposit.address, status: "ADDRESS_MINTED" },
    });
    log.info({ appId, fundingId: row.id, topUpUsd: deposit.amountUsd, to: maskAddress(deposit.address) }, "zentro deposit address minted");
    try {
      await sendForRow(row, log, now);
    } catch (err) {
      log.error({ err, appId, fundingId: row.id }, "credit funding send failed; row left for the next pass");
    }
  }
}

/** Long enough for a browser mint plus a full Relay fill wait; auto-renewed while the pass runs. */
const PASS_LOCK_TTL_SECONDS = 600;

export async function runCreditsFunding(ctx: ChainWorkerContext): Promise<void> {
  const log = ctx.log.child({ worker: "credits" });
  const pass = await withLock(
    ctx.redis,
    "lock:credits:pass",
    PASS_LOCK_TTL_SECONDS,
    async () => {
      if (await isPaused("pauseFeeSweep")) {
        log.info("paused via PlatformSetting.pauseFeeSweep");
        return;
      }
      await fundCredits(log);
    },
    { autoRenew: true },
  );
  if (!pass.acquired) log.info("credit funding skipped; pass lock held by another runner");
}

export function createCreditsWorker(ctx: ChainWorkerContext, connection: ChainWorkerContext["redis"]): Worker {
  return new Worker(CHAIN_QUEUES.credits, () => runCreditsFunding(ctx), { connection, concurrency: 1 });
}
