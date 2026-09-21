import { Worker } from "bullmq";
import { big, dec, prisma, type Prisma } from "@pyre/db";
import { LAUNCH_PHASE } from "@pyre/shared";
import { INTERVAL_SECONDS, LOG_CHUNK_BLOCKS, buildCandlesFromTrades, getEthPriceUsd, getTrades, publicClient, readLaunch, type CandleInterval, type LaunchRecord, type Trade } from "@pyre/chain";
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
/** Rebuilding a day's worth of buckets across six intervals is many statements; Prisma's 5 s default is too tight for a backfill. */
const CANDLE_TX = { timeout: 120_000, maxWait: 10_000 } as const;

type MarketApp = Prisma.AppGetPayload<{
  select: { id: true; tokenAddress: true; launchPhase: true; poolId: true; graduatedAt: true; launchBlock: true; lastIndexedBlock: true };
}>;
const MARKET_SELECT = { id: true, tokenAddress: true, launchPhase: true, poolId: true, graduatedAt: true, launchBlock: true, lastIndexedBlock: true } as const;

/** Bucket starts (unix seconds) an interval's trades fall into. */
const bucketStarts = (trades: Trade[], interval: CandleInterval): number[] => {
  const size = INTERVAL_SECONDS[interval];
  const seen: Record<number, true> = {};
  const starts: number[] = [];
  for (const t of trades) {
    const start = Math.floor(t.ts / size) * size;
    if (seen[start]) continue;
    seen[start] = true;
    starts.push(start);
  }
  return starts.sort((a, b) => a - b);
};

/**
 * Rewrites every bucket the new trades touch, in every interval, from the stored `Trade` rows of
 * that bucket window rather than by merging into the stored candle. Replaying a range (a failed
 * pass, a crash before the cursor moved) therefore yields the same buckets instead of double
 * counting volume. Stored rows carry their USD price at index time; `quoteWei` is valued at the
 * pass's ETH price, as the original build was.
 */
export async function rebuildCandles(appId: string, trades: Trade[], ethPriceUsd: number): Promise<number> {
  let written = 0;
  for (const interval of CANDLE_INTERVALS) {
    const starts = bucketStarts(trades, interval);
    if (starts.length === 0) continue;
    const size = INTERVAL_SECONDS[interval];
    const rows = await prisma.trade.findMany({
      where: { appId, ts: { gte: new Date(starts[0]! * 1000), lt: new Date((starts[starts.length - 1]! + size) * 1000) } },
      select: { txHash: true, block: true, ts: true, side: true, wallet: true, tokenUnits: true, quoteWei: true, priceUsd: true },
    });
    const stored: Trade[] = rows.map((r) => ({
      hash: r.txHash as Trade["hash"],
      block: Number(r.block),
      ts: Math.floor(r.ts.getTime() / 1000),
      side: r.side === "BUY" ? "buy" : "sell",
      wallet: r.wallet as Trade["wallet"],
      tokenUnits: big(r.tokenUnits),
      quoteWei: big(r.quoteWei),
      priceEth: ethPriceUsd > 0 ? r.priceUsd / ethPriceUsd : 0,
    }));
    const touched: Record<number, true> = {};
    for (const s of starts) touched[s] = true;
    const candles = buildCandlesFromTrades(stored, interval, ethPriceUsd).filter((c) => touched[c.t]);
    await prisma.$transaction(async (tx) => {
      for (const c of candles) {
        await tx.candle.upsert({
          where: { appId_interval_t: { appId, interval, t: c.t } },
          create: { appId, interval, ...c },
          update: { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v },
        });
      }
    }, CANDLE_TX);
    written += candles.length;
  }
  return written;
}

/**
 * One app: index fills from the cursor forward, store them, roll them into every candle interval,
 * refresh 24h volume and announce the newest fills on the live tape. The cursor is written last —
 * only once the Trade rows AND every candle interval are stored — so a failure anywhere replays
 * the range next pass; replaying is safe because `Trade.createMany` skips duplicates and the
 * candles are rebuilt from the stored trades of the range rather than merged twice.
 */
async function indexApp(ctx: ChainWorkerContext, app: MarketApp, launch: LaunchRecord, latest: bigint, ethPriceUsd: number, log: Logger): Promise<void> {
  const storedPhase = app.launchPhase;
  await syncLaunchPhase(ctx, app, launch);
  const from = (app.lastIndexedBlock ?? (app.launchBlock === null ? latest - LOG_CHUNK_BLOCKS : app.launchBlock - 1n)) + 1n;
  if (from > latest) return;
  const cap = from + LOG_CHUNK_BLOCKS * MAX_CHUNKS_PER_PASS - 1n;
  const to = cap < latest ? cap : latest;

  // A graduated launch is still scanned on both venues while the cursor is behind the tip: the
  // range may straddle (or wholly precede) the graduation block, and curve fills there are lost
  // forever once the cursor moves past them. Only at the tip can the pool alone emit fills.
  const backfilling = to < latest;
  const venues: LaunchRecord[] =
    storedPhase === LAUNCH_PHASE.CURVE || (launch.phase === LAUNCH_PHASE.POOL && backfilling) ? [{ ...launch, phase: LAUNCH_PHASE.CURVE }, launch] : [launch];
  const fills = (
    await Promise.all(venues.map(async (v) => (await getTrades(v, from, to)).map((t) => ({ ...t, venue: v.phase === LAUNCH_PHASE.POOL ? "POOL" : "CURVE" }))))
  )
    .flat()
    .sort((a, b) => a.block - b.block || a.ts - b.ts);

  if (fills.length > 0) {
    await prisma.trade.createMany({
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
  const trades: Trade[] = fills;
  if (trades.length === 0) {
    await prisma.app.update({ where: { id: app.id }, data: { lastIndexedBlock: to } });
    return;
  }

  const candles = await rebuildCandles(app.id, trades, ethPriceUsd);
  const volume = await prisma.candle.aggregate({ where: { appId: app.id, interval: "1m", t: { gte: Math.floor(Date.now() / 1000) - DAY_SECONDS } }, _sum: { v: true } });
  await prisma.app.update({ where: { id: app.id }, data: { volume24hUsd: volume._sum.v ?? 0, lastIndexedBlock: to } });

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
