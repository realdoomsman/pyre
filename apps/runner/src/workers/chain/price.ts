import { Worker } from "bullmq";
import { dec, prisma } from "@pyre/db";
import { getPrice, readLaunch } from "@pyre/chain";
import type { Address } from "viem";
import { withLock } from "../../lib/lock.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { syncLaunchPhase } from "./launchState.js";

/** Exceeds a normal pass (a few reads per app) without outliving the 60s schedule by much. */
const PASS_LOCK_TTL_SECONDS = 240;
const DAY_SECONDS = 86_400;

/**
 * 24h change from the stored 1m candles: the close of the last bucket at or before 24h ago, or —
 * for a coin younger than a day — its first bucket's open, so the figure reads "since launch".
 * Null when nothing has traded yet.
 */
export async function change24hPct(appId: string, priceUsd: number, now = Math.floor(Date.now() / 1000)): Promise<number | null> {
  const dayAgo = now - DAY_SECONDS;
  const ref =
    (await prisma.candle.findFirst({ where: { appId, interval: "1m", t: { lte: dayAgo } }, orderBy: { t: "desc" }, select: { c: true } }))?.c ??
    (await prisma.candle.findFirst({ where: { appId, interval: "1m" }, orderBy: { t: "asc" }, select: { o: true } }))?.o;
  if (ref === undefined || ref <= 0) return null;
  return ((priceUsd - ref) / ref) * 100;
}

export async function runPriceRefresh(ctx: ChainWorkerContext): Promise<void> {
  const log = ctx.log.child({ worker: "price" });
  const pass = await withLock(ctx.redis, "lock:price:pass", PASS_LOCK_TTL_SECONDS, async () => {
    const apps = await prisma.app.findMany({
      where: { tokenAddress: { not: null }, status: { in: ["LIVE", "DORMANT"] } },
      select: { id: true, tokenAddress: true, launchPhase: true, poolId: true, graduatedAt: true },
    });
    let updated = 0;
    for (const app of apps) {
      try {
        const launch = await readLaunch(app.tokenAddress as Address);
        if (!launch.exists) continue;
        await syncLaunchPhase(ctx, app, launch);
        const snapshot = await getPrice(launch);
        const change = await change24hPct(app.id, snapshot.priceUsd);
        await prisma.app.update({
          where: { id: app.id },
          data: {
            priceUsd: snapshot.priceUsd,
            marketCapUsd: snapshot.mcapUsd,
            progress: snapshot.progress,
            burnedTokens: dec(snapshot.burnedUnits),
            ...(change === null ? {} : { change24hPct: change }),
            lastPriceAt: new Date(),
          },
        });
        updated++;
      } catch (err) {
        log.warn({ err, appId: app.id, token: app.tokenAddress }, "price refresh failed for app");
      }
    }
    log.info({ apps: apps.length, updated }, "price refresh done");
  });
  if (!pass.acquired) log.info("price refresh skipped; pass lock held by another runner");
}

export function createPriceWorker(ctx: ChainWorkerContext, connection: ChainWorkerContext["redis"]): Worker {
  return new Worker(CHAIN_QUEUES.price, () => runPriceRefresh(ctx), { connection, concurrency: 1 });
}
