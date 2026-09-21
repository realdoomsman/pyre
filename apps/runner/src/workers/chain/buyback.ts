import { Worker, type Job } from "bullmq";
import type { Logger } from "pino";
import { big, dec, prisma, type Buyback, type Prisma } from "@pyre/db";
import { LAUNCH_PHASE, MIN_BUYBACK_USD, PONS_TOTAL_SUPPLY, REVENUE_SPLIT_BPS, bps, explorerTxUrl, weiFromUsdMicros } from "@pyre/shared";
import {
  attestBurn,
  attestationHash,
  burnTokens,
  curveBuy,
  curveQuoteBuy,
  getErc20Balance,
  getEthBalance,
  getEthPriceUsd,
  publicClient,
  readLaunch,
  tokenAbi,
  treasury,
  v4QuoteExactIn,
  v4SwapExactIn,
  type LaunchRecord,
} from "@pyre/chain";
import type { Address, Hash, Hex } from "viem";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { withLock } from "../../lib/lock.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { chainWorkerEnv } from "./env.js";
import { syncLaunchPhase } from "./launchState.js";
import { isPaused } from "./money.js";
import { publishEvent, publishGlobal } from "./publish.js";
import { TREASURY_FLOOR_WEI } from "./wallet.js";

const BuybackJob = z.object({ appId: z.string().min(1).optional() });
export const MIN_BUYBACK_MICROS = BigInt(MIN_BUYBACK_USD) * 1_000_000n;
const LOCK_TTL_SECONDS = 900;
/** Quoted output may move between quote and fill; the fill must deliver at least this share of it. */
const SLIPPAGE_BPS = 100n;

const APP_SELECT = {
  id: true,
  slug: true,
  ticker: true,
  tokenAddress: true,
  status: true,
  pendingRevenueMicros: true,
  launchPhase: true,
  poolId: true,
  graduatedAt: true,
} as const;
type AppRow = Prisma.AppGetPayload<{ select: typeof APP_SELECT }>;

export interface BuyResult {
  hash: Hash;
  tokensOut: bigint;
  /** Wei actually consumed (a clamped final curve buy refunds the rest). */
  spentWei: bigint;
}

/** Percent of the launch supply. */
export const burnedPctOfSupply = (units: bigint): number => (Number(units) / Number(PONS_TOTAL_SUPPLY)) * 100;

/**
 * Buys `wei` worth of the launch token to the treasury on whichever venue the launch is trading
 * on: the bonding curve before graduation, the Uniswap v4 pool after. Phases 1 (curve swept,
 * pool not yet live) and 3 (rescued) have no market and throw.
 */
export async function buyTokens(launch: LaunchRecord, wei: bigint, minOutOf: (quoted: bigint) => bigint = (q) => (q * (10_000n - SLIPPAGE_BPS)) / 10_000n): Promise<BuyResult> {
  const t = treasury();
  if (launch.phase === LAUNCH_PHASE.CURVE) {
    const quote = await curveQuoteBuy(launch.curve, wei, t.address);
    if (quote.tokensOut <= 0n) throw new Error(`curve ${launch.curve} quotes 0 tokens for ${wei} wei`);
    const buy = await curveBuy(t.account, launch.curve, wei, minOutOf(quote.tokensOut), t.address);
    return { hash: buy.hash, tokensOut: buy.tokensOut, spentWei: wei - buy.refundWei };
  }
  if (launch.phase === LAUNCH_PHASE.POOL) {
    const quoted = await v4QuoteExactIn(launch, { ethIn: wei });
    if (quoted <= 0n) throw new Error(`v4 pool ${launch.poolId} quotes 0 tokens for ${wei} wei`);
    const swap = await v4SwapExactIn(t.account, launch, { ethIn: wei }, minOutOf(quoted), t.address);
    return { hash: swap.hash, tokensOut: swap.out, spentWei: wei };
  }
  throw new Error(`launch ${launch.token} is in phase ${launch.phase}; no venue to buy on`);
}

const tradable = (launch: LaunchRecord): boolean => launch.phase === LAUNCH_PHASE.CURVE || launch.phase === LAUNCH_PHASE.POOL;

/** `totalSupply()` — the burn proof is its delta across `token.burn()`. */
const totalSupply = (token: Address): Promise<bigint> => publicClient().readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" });

/**
 * Creates the PENDING buyback for everything not yet attested, attaching the revenue events.
 * Returns null when there is nothing worth buying.
 */
async function openBuyback(app: AppRow, log: Logger): Promise<Buyback | null> {
  const events = await prisma.revenueEvent.findMany({ where: { appId: app.id, buybackId: null }, select: { id: true, usdMicros: true } });
  const revenueMicros = events.reduce((acc, e) => acc + e.usdMicros, 0n);
  if (revenueMicros < MIN_BUYBACK_MICROS) {
    log.info({ revenueMicros: revenueMicros.toString(), pendingRevenueMicros: app.pendingRevenueMicros.toString() }, "unattested revenue below buyback minimum");
    return null;
  }
  const ids = events.map((e) => e.id);
  const buybackMicros = bps(revenueMicros, REVENUE_SPLIT_BPS.BUYBACK_BURN);
  const pyreMicros = bps(revenueMicros, REVENUE_SPLIT_BPS.PYRE_TOKEN);
  const opsMicros = revenueMicros - buybackMicros - pyreMicros;
  const ethWei = weiFromUsdMicros(buybackMicros, await getEthPriceUsd());
  return prisma.$transaction(async (tx) => {
    const buyback = await tx.buyback.create({
      data: { appId: app.id, status: "PENDING", revenueMicros, ethWei: dec(ethWei), pyreMicros, opsMicros, attestHash: attestationHash(ids) },
    });
    await tx.revenueEvent.updateMany({ where: { id: { in: ids } }, data: { buybackId: buyback.id } });
    return buyback;
  });
}

/**
 * PENDING → SWAPPING → SWAPPED: ETH (buyback share) → app token to the treasury on the curve or
 * the v4 pool. Returns the SWAPPED row on success, or null when there is nothing to do (another
 * run owns it, or the buy may have broadcast and the row was left SWAPPING with an `error` for
 * manual reconcile). Any thrown error is guaranteed to originate BEFORE the on-chain buy, so the
 * caller may safely release the revenue.
 */
async function swapStage(launch: LaunchRecord, buyback: Buyback, log: Logger): Promise<Buyback | null> {
  const t = treasury();
  const ethWei = big(buyback.ethWei);
  // Pre-buy checks BEFORE any status change: the buy has not happened yet, so a throw here is safe to release.
  const balance = await getEthBalance(t.address);
  if (balance - ethWei < TREASURY_FLOOR_WEI) throw new Error(`treasury ETH ${balance} cannot cover buyback ${ethWei} above the ${TREASURY_FLOOR_WEI} floor`);

  // CAS PENDING → SWAPPING claims the buy: a crash-retry or concurrent run cannot double-buy past this point.
  const claimed = await prisma.buyback.updateMany({ where: { id: buyback.id, status: "PENDING" }, data: { status: "SWAPPING" } });
  if (claimed.count !== 1) {
    log.warn({ buybackId: buyback.id }, "buyback no longer PENDING at swap; another run owns it, skipping");
    return null;
  }

  // Past the claim the buy MAY have broadcast: never release revenue, never set FAILED.
  let buy: BuyResult;
  try {
    buy = await buyTokens(launch, ethWei);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, buybackId: buyback.id }, "buy failed after claim; it may have broadcast, leaving SWAPPING for manual reconcile");
    await prisma.buyback
      .update({ where: { id: buyback.id }, data: { error: message.slice(0, 500) } })
      .catch((e) => log.error({ err: e, buybackId: buyback.id }, "failed to persist buy error on SWAPPING row"));
    return null;
  }
  log.info({ buybackId: buyback.id, swapTx: buy.hash, tokensBought: buy.tokensOut.toString(), spentWei: buy.spentWei.toString() }, "buyback bought");
  try {
    await prisma.buyback.updateMany({
      where: { id: buyback.id, status: "SWAPPING" },
      data: { status: "SWAPPED", swapTx: buy.hash, tokensBought: dec(buy.tokensOut), ethWei: dec(buy.spentWei), error: null },
    });
    return await prisma.buyback.findUniqueOrThrow({ where: { id: buyback.id } });
  } catch (err) {
    log.error({ err, buybackId: buyback.id, swapTx: buy.hash }, "buy landed but recording SWAPPED failed; left SWAPPING for manual reconcile");
    return null;
  }
}

/**
 * SWAPPED → BURNED in three idempotent steps, each persisted before the next so a crash resumes
 * without repeating an irreversible transaction: burn (proof = totalSupply delta), attest (the
 * revenue ids hash as calldata), then settle counters, ledger and the feed.
 */
async function burnStage(ctx: ChainWorkerContext, app: AppRow, launch: LaunchRecord, buyback: Buyback, log: Logger): Promise<void> {
  const t = treasury();
  let row = buyback;
  if (!row.burnTx) {
    let amount = big(row.tokensBought);
    const held = await getErc20Balance(launch.token, t.address);
    if (amount <= 0n || amount > held) amount = held;
    if (amount <= 0n) throw new Error("no tokens to burn after the buy");
    const before = await totalSupply(launch.token);
    const burnTx = await burnTokens(t.account, launch.token, amount);
    const after = await totalSupply(launch.token);
    row = await prisma.buyback.update({ where: { id: row.id }, data: { burnTx, tokensBurned: dec(amount), burnedUnits: dec(before - after), error: null } });
    log.info({ buybackId: row.id, burnTx, amount: amount.toString(), burnedUnits: (before - after).toString() }, "buyback burned");
  }
  if (!row.attestTx) {
    const attestTx = await attestBurn(t.account, row.attestHash as Hex);
    row = await prisma.buyback.update({ where: { id: row.id }, data: { attestTx } });
    log.info({ buybackId: row.id, attestTx }, "burn attested");
  }
  const burnedUnits = big(row.burnedUnits ?? row.tokensBurned);
  const ethWei = big(row.ethWei);
  const buybackMicros = bps(row.revenueMicros, REVENUE_SPLIT_BPS.BUYBACK_BURN);
  await prisma.$transaction(async (tx) => {
    await tx.buyback.update({ where: { id: row.id }, data: { status: "BURNED", completedAt: new Date(), error: null } });
    const current = await tx.app.findUniqueOrThrow({ where: { id: app.id }, select: { pendingRevenueMicros: true } });
    const remaining = current.pendingRevenueMicros - row.revenueMicros;
    await tx.app.update({
      where: { id: app.id },
      data: { buybackWei: { increment: dec(ethWei) }, pendingRevenueMicros: remaining > 0n ? remaining : 0n },
    });
    await tx.ledgerEntry.createMany({
      data: [
        { account: "TREASURY", deltaMicros: -buybackMicros, refType: "Buyback", refId: row.id, memo: `buyback swap ${row.swapTx ?? ""} burn ${row.burnTx ?? ""} attest ${row.attestTx ?? ""}` },
        { account: "PYRE_TOKEN", deltaMicros: row.pyreMicros, refType: "Buyback", refId: row.id, memo: "$PYRE share of revenue" },
        { account: "OPS", deltaMicros: row.opsMicros, refType: "Buyback", refId: row.id, memo: "ops share of revenue" },
      ],
    });
  });
  await publishEvent(prisma, ctx.redis, app.id, {
    type: "BUYBACK",
    buybackId: row.id,
    ethWei: ethWei.toString(),
    burnedUnits: burnedUnits.toString(),
    burnedPct: burnedPctOfSupply(burnedUnits),
    swapTx: (row.swapTx as Hash | null) ?? null,
    burnTx: (row.burnTx as Hash | null) ?? null,
    attestTx: (row.attestTx as Hash | null) ?? null,
    explorerUrl: explorerTxUrl(row.burnTx as Hash),
  });
  await publishGlobal(ctx.redis, app.id);
  await audit({
    actor: "worker:buyback",
    action: "BUYBACK_BURN",
    targetType: "Buyback",
    targetId: row.id,
    meta: {
      appId: app.id,
      swapTx: row.swapTx,
      burnTx: row.burnTx,
      attestTx: row.attestTx,
      attestHash: row.attestHash,
      ethWei,
      tokensBought: big(row.tokensBought),
      tokensBurned: big(row.tokensBurned),
      burnedUnits,
      revenueMicros: row.revenueMicros,
      buybackMicros,
      pyreMicros: row.pyreMicros,
      opsMicros: row.opsMicros,
      venue: launch.phase === LAUNCH_PHASE.POOL ? "POOL" : "CURVE",
    },
  });
  log.info({ buybackId: row.id, burnTx: row.burnTx, attestTx: row.attestTx }, "buyback settled");
}

async function runBuyback(ctx: ChainWorkerContext, appId: string, log: Logger): Promise<void> {
  const app = await prisma.app.findUnique({ where: { id: appId }, select: APP_SELECT });
  if (!app?.tokenAddress || (app.status !== "LIVE" && app.status !== "DORMANT")) {
    log.info({ status: app?.status }, "app not eligible for buyback");
    return;
  }
  const launch = await readLaunch(app.tokenAddress as Address);
  await syncLaunchPhase(ctx, app, launch);
  if (!tradable(launch)) {
    log.warn({ phase: launch.phase }, "launch has no market in this phase; buyback deferred");
    return;
  }
  // A row stuck in SWAPPING is ambiguous: the buy may or may not have landed. NEVER auto-re-buy it
  // (that could double-spend). Ensure an `error` is set for the reconcile queue and skip it.
  const swapping = await prisma.buyback.findFirst({ where: { appId, status: "SWAPPING" }, orderBy: { createdAt: "asc" } });
  if (swapping) {
    log.warn({ buybackId: swapping.id }, "buyback stuck in SWAPPING; buy outcome unknown, needs manual reconcile, skipping");
    if (!swapping.error) {
      await prisma.buyback.update({ where: { id: swapping.id }, data: { error: "interrupted mid-buy; on-chain outcome unknown, manual reconcile required" } });
    }
    return;
  }
  // Resume an interrupted buyback: bought but not burned/attested/settled.
  const swapped = await prisma.buyback.findFirst({ where: { appId, status: "SWAPPED" }, orderBy: { createdAt: "asc" } });
  if (swapped) {
    try {
      await burnStage(ctx, app, launch, swapped, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, buybackId: swapped.id }, "burn stage failed; will retry next cycle");
      await prisma.buyback.update({ where: { id: swapped.id }, data: { error: message.slice(0, 500) } });
      return;
    }
  }
  const buyback =
    (await prisma.buyback.findFirst({ where: { appId, status: "PENDING" }, orderBy: { createdAt: "asc" } })) ??
    (app.pendingRevenueMicros >= MIN_BUYBACK_MICROS ? await openBuyback(app, log) : null);
  if (!buyback) return;
  let swappedRow: Buyback | null;
  try {
    swappedRow = await swapStage(launch, buyback, log);
  } catch (err) {
    // swapStage only throws for pre-buy failures (checks before the CAS claim): the buy never
    // broadcast, so it is safe to fail the buyback and release its revenue for the next cycle.
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, buybackId: buyback.id }, "swap stage failed before broadcast; revenue released for the next cycle");
    await prisma.$transaction([
      prisma.buyback.update({ where: { id: buyback.id }, data: { status: "FAILED", error: message.slice(0, 500) } }),
      prisma.revenueEvent.updateMany({ where: { buybackId: buyback.id }, data: { buybackId: null } }),
    ]);
    return;
  }
  // null: another run owns it, or the buy may have broadcast and the row was left SWAPPING for reconcile.
  if (!swappedRow) return;
  try {
    await burnStage(ctx, app, launch, swappedRow, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, buybackId: buyback.id }, "burn stage failed; will retry next cycle");
    await prisma.buyback.update({ where: { id: buyback.id }, data: { error: message.slice(0, 500) } });
  }
}

/**
 * $PYRE's own buy-and-burn. The `PYRE_TOKEN` ledger account accrues 25% of every creator fee and
 * 10% of every app's revenue; once it clears the buyback minimum the treasury buys $PYRE on its
 * curve/pool and burns it. The ledger is debited BEFORE the buy (a crash after the debit
 * under-burns and leaves the ETH in the treasury; the reverse would over-spend), the debit is
 * reversed if the buy never broadcast, and the attestation hashes the ledger rows it consumed.
 */
export async function runPyreBuyback(log: Logger): Promise<void> {
  const token = chainWorkerEnv().PYRE_TOKEN;
  if (!token) return;
  const balance = await prisma.ledgerEntry.aggregate({ where: { account: "PYRE_TOKEN" }, _sum: { deltaMicros: true } });
  const pending = balance._sum.deltaMicros ?? 0n;
  if (pending < MIN_BUYBACK_MICROS) return;
  const launch = await readLaunch(token);
  if (!launch.exists || !tradable(launch)) {
    log.warn({ token, phase: launch.phase }, "$PYRE has no market in this phase; buyback deferred");
    return;
  }
  const t = treasury();
  const ethWei = weiFromUsdMicros(pending, await getEthPriceUsd());
  const treasuryWei = await getEthBalance(t.address);
  if (treasuryWei - ethWei < TREASURY_FLOOR_WEI) {
    log.warn({ treasuryWei: treasuryWei.toString(), ethWei: ethWei.toString() }, "treasury ETH too low for the $PYRE buyback");
    return;
  }
  const lastBurn = await prisma.ledgerEntry.findFirst({ where: { account: "PYRE_TOKEN", refType: "PyreBurn" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const consumed = await prisma.ledgerEntry.findMany({
    where: { account: "PYRE_TOKEN", deltaMicros: { gt: 0n }, ...(lastBurn ? { createdAt: { gt: lastBurn.createdAt } } : {}) },
    select: { id: true },
  });
  const attestHash = attestationHash(consumed.map((e) => e.id));
  const claim = await prisma.ledgerEntry.create({
    data: { account: "PYRE_TOKEN", deltaMicros: -pending, refType: "PyreBurn", refId: attestHash, memo: "$PYRE buyback in flight" },
  });
  let buy: BuyResult;
  try {
    buy = await buyTokens(launch, ethWei);
  } catch (err) {
    // Nothing broadcast for sure only when the failure came before signing; the buy helpers quote
    // first and throw before sending on a zero quote. Any other failure is ambiguous: keep the debit
    // and let an operator settle it from the audit trail rather than risk re-buying.
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, ledgerEntryId: claim.id }, "$PYRE buy failed; ledger debit kept for manual reconcile");
    await prisma.ledgerEntry.update({ where: { id: claim.id }, data: { memo: `$PYRE buyback failed: ${message.slice(0, 300)}` } });
    return;
  }
  const before = await totalSupply(token);
  const burnTx = await burnTokens(t.account, token, buy.tokensOut);
  const after = await totalSupply(token);
  const attestTx = await attestBurn(t.account, attestHash);
  await prisma.ledgerEntry.update({ where: { id: claim.id }, data: { memo: `$PYRE buyback swap ${buy.hash} burn ${burnTx} attest ${attestTx}` } });
  await audit({
    actor: "worker:buyback",
    action: "PYRE_BURN",
    targetType: "LedgerEntry",
    targetId: claim.id,
    meta: { token, usdMicros: pending, ethWei: buy.spentWei, tokensBought: buy.tokensOut, burnedUnits: before - after, swapTx: buy.hash, burnTx, attestTx, attestHash, consumed: consumed.length },
  });
  log.info({ usdMicros: pending.toString(), ethWei: buy.spentWei.toString(), burnedUnits: (before - after).toString(), swapTx: buy.hash, burnTx, attestTx }, "$PYRE bought and burned");
}

export async function runBuybackJob(ctx: ChainWorkerContext, job: Job): Promise<void> {
  const log = ctx.log.child({ worker: "buyback", jobId: job.id });
  if (await isPaused("pauseBuyback")) {
    log.info("paused via PlatformSetting.pauseBuyback");
    return;
  }
  const data = BuybackJob.parse(job.data ?? {});
  const appIds = data.appId
    ? [data.appId]
    : (
        await prisma.app.findMany({
          where: { tokenAddress: { not: null }, status: { in: ["LIVE", "DORMANT"] }, pendingRevenueMicros: { gte: MIN_BUYBACK_MICROS } },
          select: { id: true },
        })
      ).map((a) => a.id);
  for (const appId of appIds) {
    const held = await withLock(ctx.redis, `lock:buyback:${appId}`, LOCK_TTL_SECONDS, async () => {
      try {
        await runBuyback(ctx, appId, log.child({ appId }));
      } catch (err) {
        log.error({ err, appId }, "buyback failed");
      }
    });
    if (!held.acquired) log.info({ appId }, "buyback already in progress; skipping");
  }
  if (!data.appId) {
    const held = await withLock(ctx.redis, "lock:buyback:pyre", LOCK_TTL_SECONDS, async () => {
      try {
        await runPyreBuyback(log.child({ leg: "pyre" }));
      } catch (err) {
        log.error({ err }, "$PYRE buyback failed");
      }
    });
    if (!held.acquired) log.info("$PYRE buyback already in progress; skipping");
  }
}

export function createBuybackWorker(ctx: ChainWorkerContext, connection: ChainWorkerContext["redis"]): Worker {
  return new Worker(CHAIN_QUEUES.buyback, (job) => runBuybackJob(ctx, job), { connection, concurrency: 1 });
}
