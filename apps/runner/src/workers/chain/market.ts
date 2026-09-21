import { Worker } from "bullmq";
import { dec, prisma, type Prisma } from "@pyre/db";
import { LAUNCH_PHASE } from "@pyre/shared";
import { LOG_CHUNK_BLOCKS, buildCandlesFromTrades, getEthPriceUsd, getTrades, publicClient, readLaunch, type Candle, type CandleInterval, type LaunchRecord, type Trade } from "@pyre/chain";
import type { Logger } from "pino";
import type { Address } from "viem";
import { withLock } from "../../lib/lock.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { syncLaunchPhase } from "./launchState.js";
import { publishEvent, publishGlobal } from "./publish.js";

export const CANDLE_INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
/** At most this many 10k-block chunks per app per pass (≈1.4 h of chain time); a backfill converges over a few passes. */
const MAX_CHUNKS_PER_PASS = 5n;
/** Live-tape events published per app per pass; older fills in a backfill are stored, not announced. */
const TRADE_EVENTS_PER_PASS = 20;
const PASS_LOCK_TTL_SECONDS = 240;
const DAY_SECONDS = 86_400;

type MarketApp = Prisma.AppGetPayload<{
  select: { id: true; tokenAddress: true; launchPhase: true; poolId: true; graduatedAt: true; launchBlock: true; lastIndexedBlock: true };
}>;
const MARKET_SELECT = { id: true, tokenAddress: true, launchPhase: true, poolId: true, graduatedAt: true, launchBlock: true, lastIndexedBlock: true } as const;

/** Merges freshly built buckets into stored ones: open stays, high/low widen, close and volume roll forward. */
export function mergeCandle(existing: Candle | undefined, fresh: Candle): Candle {
  if (!existing) return fresh;
  return { t: fresh.t, o: existing.o, h: Math.max(existing.h, fresh.h), l: Math.min(existing.l, fresh.l), c: fresh.c, v: existing.v + fresh.v };
}

async function upsertCandles(appId: string, trades: Trade[], ethPriceUsd: number): Promise<number> {
  let written = 0;
  for (const interval of CANDLE_INTERVALS) {
    const fresh = buildCandlesFromTrades(trades, interval, ethPriceUsd);
    if (fresh.length === 0) continue;
    const stored = await prisma.candle.findMany({ where: { appId, interval, t: { in: fresh.map((c) => c.t) } }, select: { t: true, o: true, h: true, l: true, c: true, v: true } });
    const byT: Record<number, Candle> = {};
    for (const c of stored) byT[c.t] = c;
    await prisma.$transaction(
      fresh.map((c) => {
        const merged = mergeCandle(byT[c.t], c);
        return prisma.candle.upsert({
          where: { appId_interval_t: { appId, interval, t: c.t } },
          create: { appId, interval, ...merged },
          update: { o: merged.o, h: merged.h, l: merged.l, c: merged.c, v: merged.v },
        });
      }),
    );
    written += fresh.length;
  }
  return written;
}

/**
 * One app: index fills from the cursor forward (both venues when the launch graduated inside the
 * range), store them, roll them into every candle interval, refresh 24h volume and announce the
 * newest fills on the live tape. Trade rows and the cursor commit together.
 */
async function indexApp(ctx: ChainWorkerContext, app: MarketApp, launch: LaunchRecord, latest: bigint, ethPriceUsd: number, log: Logger): Promise<void> {
  const storedPhase = app.launchPhase;
  await syncLaunchPhase(ctx, app, launch);
  const from = (app.lastIndexedBlock ?? (app.launchBlock === null ? latest - LOG_CHUNK_BLOCKS : app.launchBlock - 1n)) + 1n;
  if (from > latest) return;
  const cap = from + LOG_CHUNK_BLOCKS * MAX_CHUNKS_PER_PASS - 1n;
  const to = cap < latest ? cap : latest;

  const venues: LaunchRecord[] =
    storedPhase === LAUNCH_PHASE.CURVE && launch.phase === LAUNCH_PHASE.POOL ? [{ ...launch, phase: LAUNCH_PHASE.CURVE }, launch] : [launch];
  const fills = (
    await Promise.all(venues.map(async (v) => (await getTrades(v, from, to)).map((t) => ({ ...t, venue: v.phase === LAUNCH_PHASE.POOL ? "POOL" : "CURVE" }))))
  )
    .flat()
    .sort((a, b) => a.block - b.block || a.ts - b.ts);

  await prisma.$transaction(async (tx) => {
    if (fills.length > 0) {
      await tx.trade.createMany({
        data: fills.map((t) => ({
          appId: app.id,
          txHash: t.hash,
          block: BigInt(t.block),
          ts: new Date(t.ts * 1000),
          side: t.side === "buy" ? "BUY" : "SELL",
          venue: t.venue,
          wallet: t.wallet,
          tokenUnits: dec(t.tokenUnits),
          quoteWei: dec(t.quoteWei),
          priceUsd: t.priceEth * ethPriceUsd,
        })),
        skipDuplicates: true,
      });
    }
    await tx.app.update({ where: { id: app.id }, data: { lastIndexedBlock: to } });
  });
  const trades: Trade[] = fills;
  if (trades.length === 0) return;

  const candles = await upsertCandles(app.id, trades, ethPriceUsd);
  const volume = await prisma.candle.aggregate({ where: { appId: app.id, interval: "1m", t: { gte: Math.floor(Date.now() / 1000) - DAY_SECONDS } }, _sum: { v: true } });
  await prisma.app.update({ where: { id: app.id }, data: { volume24hUsd: volume._sum.v ?? 0 } });

  for (const t of trades.slice(-TRADE_EVENTS_PER_PASS)) {
    await publishEvent(prisma, ctx.redis, app.id, {
      type: "TRADE",
      side: t.side === "buy" ? "BUY" : "SELL",
      wallet: t.wallet,
      tokenUnits: t.tokenUnits.toString(),
      quoteWei: t.quoteWei.toString(),
      priceUsd: t.priceEth * ethPriceUsd,
      txHash: t.hash,
    });
  }
  await publishGlobal(ctx.redis, app.id);
  log.info({ appId: app.id, from: from.toString(), to: to.toString(), trades: trades.length, candles, caughtUp: to === latest }, "market indexed");
}

export async function runMarketRefresh(ctx: ChainWorkerContext): Promise<void> {
  const log = ctx.log.child({ worker: "market" });
  const pass = await withLock(ctx.redis, "lock:market:pass", PASS_LOCK_TTL_SECONDS, async () => {
    const apps = await prisma.app.findMany({ where: { tokenAddress: { not: null }, status: { in: ["LIVE", "DORMANT"] } }, select: MARKET_SELECT });
    if (apps.length === 0) return;
    const [latest, ethPriceUsd] = await Promise.all([publicClient().getBlockNumber(), getEthPriceUsd()]);
    for (const app of apps) {
      try {
        const launch = await readLaunch(app.tokenAddress as Address);
        if (!launch.exists) continue;
        await indexApp(ctx, app, launch, latest, ethPriceUsd, log);
      } catch (err) {
        log.warn({ err, appId: app.id, token: app.tokenAddress }, "market refresh failed for app");
      }
    }
  });
  if (!pass.acquired) log.info("market refresh skipped; pass lock held by another runner");
}

export function createMarketWorker(ctx: ChainWorkerContext, connection: ChainWorkerContext["redis"]): Worker {
  return new Worker(CHAIN_QUEUES.market, () => runMarketRefresh(ctx), { connection, concurrency: 1 });
}
