import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import type { Logger } from "pino";
import { formatLog, getAbiItem, getAddress, numberToHex, parseEventLogs, toEventSelector, type RpcLog } from "viem";
import { big, dec, prisma } from "@pyre/db";
import {
  REFUND_LEDGER_ACCOUNT,
  REFUND_MAX_PAYOUTS_PER_RUN,
  REFUND_MIN_PAYOUT_MICROS,
  REFUND_SNAPSHOT,
  allocateRefunds,
  nativeFromUsdMicros,
  refundEligibleWei,
  refundRemainingWei,
} from "@pyre/shared";
import {
  LOG_CHUNK_BLOCKS,
  SolanaTransactionFailedError,
  SolanaTransactionUnconfirmedError,
  adapterFor,
  getEthPriceUsd,
  getSolBalance,
  getSolPriceUsd,
  publicClient,
  rpcBatch,
  solSigner,
  solanaConnection,
  solanaEnabled,
  tokenAbi,
  transferSol,
} from "@pyre/chain";
import { audit } from "../../lib/audit.js";
import { withLock } from "../../lib/lock.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { isPaused } from "./money.js";

/**
 * PYRE holder refunds. Each pass (under one Redis lock, so two runners never overlap):
 *   1. resolves SENT payouts from their signature status,
 *   2. tracks every holder's Robinhood PYRE balance from Transfer logs since the snapshot
 *      (currentBalanceUnits, and minBalanceUnits = the lowest it has been), up to a reorg-safe head,
 *   3. allocates the REFUND ledger balance pro-rata to every holder's remaining eligible wei
 *      (owed scaled by the snapshot PYRE still held, minus settled; one transaction: ledger debit +
 *      creditMicros/settledWei per holder) — only when step 2 succeeded and reached that head, so a
 *      holder who sold is never allocated on stale balances,
 *   4. pays linked holders their credit in SOL from the treasury Solana wallet, marker first:
 *      the RefundPayout row is created and the credit decremented before anything is sent.
 *      Credit already allocated stays payable after a sell (it was earned while holding).
 */

/** SOL the treasury Solana wallet always keeps for its own claims, launches and fees: 0.1 SOL. */
export const REFUND_SOL_FLOOR_LAMPORTS = 100_000_000n;
const LOCK_TTL_SECONDS = 900;
const SOL_DECIMALS = 9;
/** `PlatformSetting` key: last Robinhood block whose PYRE Transfer logs are applied to RefundHolder balances. */
export const REFUND_HOLD_CURSOR_KEY = "refund:holdCursor";
/**
 * Holding is tracked only this far behind the tip: 600 blocks ≈ 60 s at Robinhood Chain's ~0.1 s
 * blocks. Nitro reorgs only on a sequencer-feed/L1 hiccup, and those resolve within seconds; a
 * minute also outlasts the replica lag seen behind the public load-balanced RPC. Each chunk is
 * additionally fetched together with its end block in one JSON-RPC batch (see `holdingChunk`), so
 * a lagging node fails the pass instead of returning a short log list. Tracking a minute late costs
 * nothing: allocation runs every 10 minutes.
 */
export const HOLD_REORG_BLOCKS = 600n;
/** ≤10k-block chunks per pass (≈8 h of chain time); a backlog converges over a few passes, with allocation held off until it does. */
const HOLD_MAX_CHUNKS_PER_PASS = 30n;
const HOLD_TX = { timeout: 120_000, maxWait: 10_000 } as const;
const TRANSFER_EVENT = getAbiItem({ abi: tokenAbi, name: "Transfer" });
const TRANSFER_TOPIC = toEventSelector(TRANSFER_EVENT);

const payoutsFrozen = (): boolean => process.env.PAYOUTS_FROZEN === "1";

/**
 * PYRE Transfer logs in [start, end], read in ONE JSON-RPC batch together with block `end` from the
 * same node: a node that has not reached `end` (a lagging replica behind a load balancer) answers
 * null for the block and the chunk fails, instead of silently returning fewer logs and letting the
 * cursor skip them for good.
 */
async function holdingChunk(start: bigint, end: bigint) {
  const token = getAddress(REFUND_SNAPSHOT.token);
  const [block, raw] = await rpcBatch([
    { method: "eth_getBlockByNumber", params: [numberToHex(end), false] },
    { method: "eth_getLogs", params: [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: numberToHex(start), toBlock: numberToHex(end) }] },
  ]);
  if (!block) throw new Error(`RPC node has not reached block ${end}; holding not advanced`);
  if (!Array.isArray(raw)) throw new Error("eth_getLogs returned a non-array");
  return parseEventLogs({ abi: [TRANSFER_EVENT], logs: (raw as RpcLog[]).map((l) => formatLog(l)), strict: true });
}

/**
 * Applies PYRE Transfer logs after the holding cursor to every RefundHolder in (block, logIndex)
 * order: a debit lowers currentBalanceUnits and pulls minBalanceUnits down with it, a credit only
 * raises currentBalanceUnits (buying back never restores eligibility). Balances and cursor are
 * written in one transaction, so a crash replays nothing and skips nothing. Returns true when the
 * balances are current up to the reorg-safe head (allocation may run), false while a backlog remains.
 *
 * Never runs (and never moves the cursor) while RefundHolder is empty: the snapshot must be loaded
 * first, or every post-snapshot sell would be skipped. Replay-safe: a pass that starts from the
 * snapshot block (cursor absent or deleted) resets every holder to its snapshot balance before
 * applying logs, so deleting the cursor recomputes the same balances from scratch.
 */
export async function trackHolding(log: Logger): Promise<boolean> {
  const rows = await prisma.refundHolder.findMany({ select: { address: true, balanceUnits: true, currentBalanceUnits: true, minBalanceUnits: true } });
  if (rows.length === 0) {
    log.warn("no RefundHolder rows (snapshot not loaded); holding cursor left untouched");
    return false;
  }
  const setting = await prisma.platformSetting.findUnique({ where: { key: REFUND_HOLD_CURSOR_KEY } });
  const snapshotBlock = BigInt(REFUND_SNAPSHOT.block);
  const cursor = typeof setting?.value === "string" ? BigInt(setting.value) : snapshotBlock;
  const head = (await publicClient().getBlockNumber()) - HOLD_REORG_BLOCKS;
  const from = cursor + 1n;
  if (from > head) return true;
  const cap = from + LOG_CHUNK_BLOCKS * HOLD_MAX_CHUNKS_PER_PASS - 1n;
  const to = cap < head ? cap : head;

  const fromSnapshot = cursor === snapshotBlock;
  const holders = new Map(
    rows.map((r) => {
      const start = fromSnapshot ? big(r.balanceUnits) : null;
      return [r.address, { current: start ?? big(r.currentBalanceUnits), min: start ?? big(r.minBalanceUnits) }];
    }),
  );
  // From the snapshot every row is rewritten, so a replay overwrites whatever an earlier run left.
  const changed = new Set<string>(fromSnapshot ? holders.keys() : []);
  let applied = 0;
  for (let start = from; start <= to; start += LOG_CHUNK_BLOCKS) {
    const end = start + LOG_CHUNK_BLOCKS - 1n < to ? start + LOG_CHUNK_BLOCKS - 1n : to;
    const logs = await holdingChunk(start, end);
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    for (const entry of logs) {
      const sender = getAddress(entry.args.from);
      const recipient = getAddress(entry.args.to);
      // A self-transfer moves nothing.
      if (sender === recipient) continue;
      const out = holders.get(sender);
      if (out) {
        out.current -= entry.args.value;
        if (out.current < out.min) out.min = out.current;
        changed.add(sender);
      }
      const into = holders.get(recipient);
      if (into) {
        into.current += entry.args.value;
        changed.add(recipient);
      }
      if (out || into) applied++;
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const address of changed) {
      const h = holders.get(address)!;
      await tx.refundHolder.update({ where: { address }, data: { currentBalanceUnits: dec(h.current), minBalanceUnits: dec(h.min) } });
    }
    await tx.platformSetting.upsert({ where: { key: REFUND_HOLD_CURSOR_KEY }, create: { key: REFUND_HOLD_CURSOR_KEY, value: to.toString() }, update: { value: to.toString() } });
  }, HOLD_TX);
  log.info({ from: from.toString(), to: to.toString(), transfers: applied, holders: changed.size, fromSnapshot, caughtUp: to === head }, "refund holding tracked from PYRE transfer logs");
  return to === head;
}

/** Allocates the REFUND pool. Returns the run id, or null when nothing was allocated. */
export async function allocateRefundPool(log: Logger): Promise<string | null> {
  const pool = (await prisma.ledgerEntry.aggregate({ where: { account: REFUND_LEDGER_ACCOUNT }, _sum: { deltaMicros: true } }))._sum.deltaMicros ?? 0n;
  if (pool < REFUND_MIN_PAYOUT_MICROS) return null;
  let ethPriceUsd: number;
  try {
    ethPriceUsd = await getEthPriceUsd();
  } catch (err) {
    log.warn({ err }, "ETH price unavailable; refund allocation skipped");
    return null;
  }
  const holders = await prisma.refundHolder.findMany({
    where: { settledWei: { lt: prisma.refundHolder.fields.owedWei }, minBalanceUnits: { gt: 0 } },
    select: { address: true, owedWei: true, settledWei: true, balanceUnits: true, minBalanceUnits: true },
  });
  const settledBefore = new Map(holders.map((h) => [h.address, big(h.settledWei)]));
  const { allocations, leftoverMicros } = allocateRefunds(
    pool,
    holders.map((h) => ({
      address: h.address,
      remainingWei: refundRemainingWei(refundEligibleWei(big(h.owedWei), big(h.balanceUnits), big(h.minBalanceUnits)), big(h.settledWei)),
    })),
    ethPriceUsd,
  );
  if (allocations.length === 0) return null;
  const totalMicros = pool - leftoverMicros;
  const runId = randomUUID();
  await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction: the pool may only have grown since (fee sweep credits), never shrunk.
    const current = (await tx.ledgerEntry.aggregate({ where: { account: REFUND_LEDGER_ACCOUNT }, _sum: { deltaMicros: true } }))._sum.deltaMicros ?? 0n;
    if (current < totalMicros) throw new Error(`REFUND pool shrank to ${current} under allocation of ${totalMicros}`);
    if (totalMicros > 0n) {
      await tx.ledgerEntry.create({ data: { account: REFUND_LEDGER_ACCOUNT, deltaMicros: -totalMicros, refType: "RefundAllocation", refId: runId, memo: `refund allocation to ${allocations.length} holders` } });
    }
    for (const a of allocations) {
      const before = settledBefore.get(a.address)!;
      // Compare-and-set on settledWei: a concurrent writer aborts the whole allocation instead of over-settling.
      const updated = await tx.refundHolder.updateMany({
        where: { address: a.address, settledWei: dec(before) },
        data: { settledWei: dec(before + a.wei), creditMicros: { increment: a.micros } },
      });
      if (updated.count !== 1) throw new Error(`refund holder ${a.address} changed during allocation`);
    }
  });
  log.info({ runId, ethPriceUsd, holders: allocations.length, totalMicros: totalMicros.toString(), leftoverMicros: leftoverMicros.toString() }, "refund pool allocated");
  await audit({
    actor: "worker:refunds",
    action: "REFUND_ALLOCATION",
    targetType: "RefundAllocation",
    targetId: runId,
    meta: { ethPriceUsd, poolMicros: pool, totalMicros, leftoverMicros, holders: allocations.length },
  });
  return runId;
}

async function confirmPayout(id: string, address: string, usdMicros: bigint, txSig: string): Promise<void> {
  await prisma.$transaction([
    prisma.refundPayout.update({ where: { id }, data: { status: "CONFIRMED", txSig, confirmedAt: new Date(), error: null } }),
    prisma.refundHolder.update({ where: { address }, data: { paidMicros: { increment: usdMicros } } }),
  ]);
}

async function failPayout(id: string, address: string, usdMicros: bigint, error: string): Promise<void> {
  await prisma.$transaction([
    prisma.refundPayout.update({ where: { id }, data: { status: "FAILED", error } }),
    prisma.refundHolder.update({ where: { address }, data: { creditMicros: { increment: usdMicros } } }),
  ]);
}

/** Why payouts must not move right now, or null: re-read before every transfer so an incident pause stops a run mid-way. */
async function payoutHold(): Promise<string | null> {
  if (payoutsFrozen()) return "PAYOUTS_FROZEN";
  if (await isPaused("pause_refunds")) return "PlatformSetting.pause_refunds";
  return null;
}

/**
 * Pays linked holders their accrued credit. Returns the number of payouts attempted. A holder whose
 * payout wallet was just changed to a different one (`linkPendingUntil` in the future) is skipped
 * until the relink cooldown ends; credit keeps accruing meanwhile.
 */
export async function payRefunds(log: Logger, now: Date = new Date()): Promise<number> {
  const held = await payoutHold();
  if (held) {
    log.info({ via: held }, "refund payouts paused");
    return 0;
  }
  if (!solanaEnabled()) return 0;
  const due = await prisma.refundHolder.findMany({
    where: {
      solWallet: { not: null },
      creditMicros: { gte: REFUND_MIN_PAYOUT_MICROS },
      OR: [{ linkPendingUntil: null }, { linkPendingUntil: { lte: now } }],
    },
    select: { address: true, solWallet: true, creditMicros: true },
    orderBy: { creditMicros: "desc" },
    take: REFUND_MAX_PAYOUTS_PER_RUN,
  });
  if (due.length === 0) return 0;
  const treasury = adapterFor("pump_fun").treasury();
  const signer = solSigner(treasury);
  const solPriceUsd = await getSolPriceUsd();
  let balance = await getSolBalance(treasury.address);
  let attempted = 0;
  for (const h of due) {
    const usdMicros = h.creditMicros;
    const lamports = nativeFromUsdMicros(usdMicros, solPriceUsd, SOL_DECIMALS);
    if (lamports <= 0n) continue;
    if (balance - lamports < REFUND_SOL_FLOOR_LAMPORTS) {
      log.warn({ balance: balance.toString(), lamports: lamports.toString(), floor: REFUND_SOL_FLOOR_LAMPORTS.toString() }, "treasury Solana wallet below refund floor; payouts stop");
      break;
    }
    const heldNow = await payoutHold();
    if (heldNow) {
      log.info({ via: heldNow, attempted }, "refund payouts paused mid-run; remaining holders wait");
      break;
    }
    const solWallet = h.solWallet!;
    // Marker: the payout row exists and the credit is taken before any SOL moves. The cooldown is
    // re-checked here so a relink that lands after the select is never paid early.
    const payout = await prisma.$transaction(async (tx) => {
      const taken = await tx.refundHolder.updateMany({
        where: { address: h.address, solWallet, creditMicros: usdMicros, OR: [{ linkPendingUntil: null }, { linkPendingUntil: { lte: now } }] },
        data: { creditMicros: { decrement: usdMicros } },
      });
      if (taken.count !== 1) return null;
      return tx.refundPayout.create({ data: { address: h.address, solWallet, usdMicros, lamports: dec(lamports), solPriceUsd, status: "PENDING" } });
    });
    if (!payout) continue;
    attempted++;
    const plog = log.child({ payoutId: payout.id, address: h.address, solWallet });
    try {
      const sent = await transferSol(signer, solWallet, lamports);
      await confirmPayout(payout.id, h.address, usdMicros, sent.signature);
      balance -= lamports;
      plog.info({ txSig: sent.signature, lamports: lamports.toString(), usdMicros: usdMicros.toString() }, "refund paid");
      await audit({ actor: "worker:refunds", action: "REFUND_PAYOUT", targetType: "RefundPayout", targetId: payout.id, meta: { status: "CONFIRMED", address: h.address, solWallet, usdMicros, lamports, solPriceUsd, txSig: sent.signature } });
    } catch (err) {
      if (err instanceof SolanaTransactionUnconfirmedError) {
        const lastValidBlockHeight = err.lastValidBlockHeight === undefined ? null : BigInt(err.lastValidBlockHeight);
        await prisma.refundPayout.update({ where: { id: payout.id }, data: { status: "SENT", txSig: err.signature, error: err.message, lastValidBlockHeight } });
        balance -= lamports;
        plog.warn({ txSig: err.signature, lastValidBlockHeight: lastValidBlockHeight?.toString() }, "refund broadcast but unconfirmed; left SENT for reconciliation");
        await audit({ actor: "worker:refunds", action: "REFUND_PAYOUT", targetType: "RefundPayout", targetId: payout.id, meta: { status: "SENT", address: h.address, solWallet, usdMicros, lamports, txSig: err.signature, lastValidBlockHeight } });
      } else if (err instanceof SolanaTransactionFailedError) {
        await failPayout(payout.id, h.address, usdMicros, err.message);
        plog.warn({ err }, "refund transfer failed; credit restored");
        await audit({ actor: "worker:refunds", action: "REFUND_PAYOUT", targetType: "RefundPayout", targetId: payout.id, meta: { status: "FAILED", address: h.address, solWallet, usdMicros, lamports, error: err.message } });
      } else {
        // Transport error: whether anything was broadcast is unknown and there is no signature to
        // look up. The row stays PENDING with its credit taken (never double-pay); the REFUNDS
        // reconcile check reports it for an operator, and this run stops (the RPC is likely down).
        const message = err instanceof Error ? err.message : String(err);
        await prisma.refundPayout.update({ where: { id: payout.id }, data: { error: message } });
        plog.error({ err }, "refund transfer outcome unknown; left PENDING for an operator");
        break;
      }
    }
  }
  return attempted;
}

/**
 * Resolves SENT payouts from their signature status (full history search): confirmed/finalized →
 * CONFIRMED + paid (or FAILED + credit restored when it errored). An unknown signature is FAILED
 * (credit restored, so it is paid again) ONLY once the finalized block height is past the
 * transaction's lastValidBlockHeight — read before the statuses, so a status that is still null
 * afterwards proves the blockhash died unlanded. `processed`, a height not yet past, or a row with
 * no recorded lastValidBlockHeight stays SENT (the REFUNDS reconcile check surfaces it).
 */
export async function resolveSentRefunds(log: Logger): Promise<number> {
  const sent = await prisma.refundPayout.findMany({ where: { status: "SENT" }, orderBy: { createdAt: "asc" }, take: 100 });
  if (sent.length === 0 || !solanaEnabled()) return 0;
  const withSig = sent.filter((p) => p.txSig);
  if (withSig.length === 0) return 0;
  const conn = solanaConnection();
  const finalizedHeight = BigInt(await conn.getBlockHeight("finalized"));
  const { value } = await conn.getSignatureStatuses(
    withSig.map((p) => p.txSig!),
    { searchTransactionHistory: true },
  );
  let resolved = 0;
  for (const [i, p] of withSig.entries()) {
    const status = value[i];
    const settled = status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized");
    let final: "CONFIRMED" | "FAILED";
    if (settled && status.err) {
      await failPayout(p.id, p.address, p.usdMicros, `transaction failed: ${JSON.stringify(status.err)}`);
      final = "FAILED";
    } else if (settled) {
      await confirmPayout(p.id, p.address, p.usdMicros, p.txSig!);
      final = "CONFIRMED";
    } else if (!status && p.lastValidBlockHeight !== null && finalizedHeight > p.lastValidBlockHeight) {
      await failPayout(p.id, p.address, p.usdMicros, `signature never landed; blockhash expired (finalized height ${finalizedHeight} > ${p.lastValidBlockHeight})`);
      final = "FAILED";
    } else continue;
    resolved++;
    log.info({ payoutId: p.id, txSig: p.txSig, status: final }, "SENT refund resolved");
    await audit({ actor: "worker:refunds", action: "REFUND_PAYOUT", targetType: "RefundPayout", targetId: p.id, meta: { status: final, resolved: true, address: p.address, usdMicros: p.usdMicros, txSig: p.txSig } });
  }
  return resolved;
}

export async function runRefunds(ctx: ChainWorkerContext): Promise<void> {
  const log = ctx.log.child({ worker: "refunds" });
  const pass = await withLock(ctx.redis, "lock:refunds:pass", LOCK_TTL_SECONDS, async () => {
    await resolveSentRefunds(log);
    let holdingCurrent = false;
    try {
      holdingCurrent = await trackHolding(log);
    } catch (err) {
      log.warn({ err }, "refund holding tracking failed; allocation skipped this pass");
    }
    if (holdingCurrent) await allocateRefundPool(log);
    else log.info("refund holding not yet current; allocation skipped this pass");
    await payRefunds(log);
  }, { autoRenew: true });
  if (!pass.acquired) log.info("refund pass skipped; lock held by another runner");
}

export function createRefundsWorker(ctx: ChainWorkerContext, connection: ChainWorkerContext["redis"]): Worker {
  return new Worker(CHAIN_QUEUES.refunds, () => runRefunds(ctx), { connection, concurrency: 1 });
}
