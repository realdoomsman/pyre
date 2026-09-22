import { Router } from "express";
import { z } from "zod";
import { big, prisma } from "@pyre/db";
import { adapterFor, getEthPriceUsd, publicClient, solanaEnabled } from "@pyre/chain";
import { type BurnsPageDto, type StatsDto } from "@pyre/shared";
import { env } from "../env.js";
import { APPS_TAG, cacheKey, cached } from "../lib/cache.js";
import { pctOfSupply, pyreBurnDto } from "../lib/dto.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { pageQuery, sendCached } from "../lib/http.js";
import { db } from "../lib/metrics.js";
import { marketSnapshot } from "../lib/market.js";
import { queues } from "../lib/queues.js";
import { redis } from "../lib/redis.js";
import { listCounts } from "./apps.js";

export const publicRoutes = Router();

const DAY_MS = 86_400_000;

/**
 * Platform aggregates. Everything here is Postgres (one batched transaction) plus the runner's
 * market snapshot row; nothing in this path touches the RPC or a price feed, so a cold request
 * costs a few indexed queries. Cached 30 s (`STATS_TTL_MS`) and served with `s-maxage=30, swr=120`.
 */
const loadStats = async (): Promise<StatsDto> => {
  const now = Date.now();
  const since24h = new Date(now - DAY_MS);
  const since30d = new Date(now - 30 * DAY_MS);
  const dayStart = new Date(new Date(now).toISOString().slice(0, 10));
  // One batched transaction for every platform aggregate: a single round trip, one snapshot.
  const [totals, totalsSol, live, building, total, jobsToday, pyreAll, pyre24h, pyre30d] = await db.$transaction([
    db.app.aggregate({ where: { chain: "robinhood" }, _sum: { feesWei: true } }),
    db.app.aggregate({ where: { chain: "solana" }, _sum: { feesWei: true } }),
    db.app.count({ where: { status: "LIVE" } }),
    db.app.count({ where: { jobs: { some: { status: { in: ["RUNNING", "QUEUED"] } } } } }),
    db.app.count({ where: { status: { in: ["LIVE", "DORMANT"] }, tokenAddress: { not: null } } }),
    db.buildJob.findMany({
      where: { startedAt: { gte: dayStart } },
      select: { startedAt: true, finishedAt: true },
    }),
    // ETH burned = $PYRE's buy-and-burns: the platform's 25% share of every coin's creator fees.
    db.pyreBurn.aggregate({ where: { status: "BURNED" }, _sum: { ethWei: true }, _count: true }),
    db.pyreBurn.aggregate({ where: { status: "BURNED", completedAt: { gte: since24h } }, _sum: { ethWei: true } }),
    db.pyreBurn.aggregate({ where: { status: "BURNED", completedAt: { gte: since30d } }, _sum: { ethWei: true } }),
  ]);
  const [market, counts] = await Promise.all([marketSnapshot(), listCounts()]);
  const pyre = market?.pyreToken ?? null;
  let agentMs = 0;
  for (const j of jobsToday) {
    if (!j.startedAt) continue;
    agentMs += (j.finishedAt ?? new Date(now)).getTime() - j.startedAt.getTime();
  }
  return {
    appsLive: live,
    appsBuilding: building,
    appsTotal: total,
    feesTotalWei: big(totals._sum.feesWei).toString(),
    feesTotalLamports: big(totalsSol._sum.feesWei).toString(),
    burnedEthWei: big(pyreAll._sum.ethWei).toString(),
    burnedEth24hWei: big(pyre24h._sum.ethWei).toString(),
    burnedEth30dWei: big(pyre30d._sum.ethWei).toString(),
    counts,
    pyreBurnsCount: pyreAll._count,
    agentHoursToday: Math.round((agentMs / 3_600_000) * 100) / 100,
    ethPriceUsd: market?.ethPriceUsd ?? 0,
    solPriceUsd: market?.solPriceUsd ?? null,
    pyreToken: pyre
      ? {
          address: pyre.address,
          priceUsd: pyre.priceUsd,
          mcapUsd: pyre.mcapUsd,
          burnedUnits: pyre.burnedUnits,
          burnedPct: pctOfSupply(BigInt(pyre.burnedUnits)),
        }
      : null,
    updatedAt: new Date(now).toISOString(),
  };
};

/** `/stats` is identical for every viewer: one shared cache entry, refreshed at most every 30 s. */
export const STATS_TTL_MS = 30_000;

publicRoutes.get(
  "/stats",
  wrap(async (_req, res) => {
    sendCached(res, await cached("stats", STATS_TTL_MS, loadStats, [APPS_TAG]), { maxAge: 30, swr: 120 });
  }),
);

const BurnsQuery = pageQuery(50, 100);

/**
 * Global $PYRE burn ledger, newest first, with running totals as of each row so a page reads like
 * a statement. Totals are computed from the rows after the cursor plus everything older, in one
 * grouped aggregate per page.
 */
const loadBurns = async (q: z.infer<typeof BurnsQuery>): Promise<BurnsPageDto> => {
  const where = { status: "BURNED" as const };
  const rows = await db.pyreBurn.findMany({
    where,
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, q.limit);
  const last = items[items.length - 1];
  const [totals, older] = await Promise.all([
    db.pyreBurn.aggregate({ where, _sum: { ethWei: true, usdMicros: true }, _count: { _all: true } }),
    last
      ? db.pyreBurn.aggregate({
          where: { ...where, OR: [{ completedAt: { lt: last.completedAt! } }, { completedAt: last.completedAt!, id: { lt: last.id } }] },
          _sum: { ethWei: true, usdMicros: true },
        })
      : Promise.resolve(null),
  ]);
  // Walk the page oldest → newest so each row carries the cumulative total up to and including itself.
  let ethWei = big(older?._sum.ethWei);
  let usdMicros = older?._sum.usdMicros ?? 0n;
  const withTotals = [...items].reverse().map((b) => {
    ethWei += big(b.ethWei);
    usdMicros += b.usdMicros;
    return { ...pyreBurnDto(b), cumulativeEthWei: ethWei.toString(), cumulativeUsdMicros: usdMicros.toString() };
  });
  return {
    items: withTotals.reverse(),
    nextCursor: rows.length > q.limit ? last!.id : null,
    totals: {
      ethWei: big(totals._sum.ethWei).toString(),
      usdMicros: (totals._sum.usdMicros ?? 0n).toString(),
      burns: totals._count._all,
    },
  };
};

publicRoutes.get(
  "/burns",
  wrap(async (req, res) => {
    const q = parse(BurnsQuery, req.query);
    const page = await cached(cacheKey("burns", { cursor: q.cursor ?? null, limit: q.limit }), 15_000, () => loadBurns(q), [APPS_TAG]);
    sendCached(res, page, { maxAge: 15, swr: 60 });
  }),
);

const bootedAt = Date.now();

const timed = async <T>(work: () => Promise<T>): Promise<{ ok: boolean; latencyMs: number; value: T | null }> => {
  const start = performance.now();
  try {
    const value = await work();
    return { ok: true, latencyMs: Math.round(performance.now() - start), value };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - start), value: null };
  }
};

/** `GET /v1/status` — dependency health for the public status page (`/health` stays a bare probe). */
publicRoutes.get(
  "/status",
  wrap(async (_req, res) => {
    const [dbCheck, redisCheck, rpcCheck, queueCheck, price, solana] = await Promise.all([
      timed(() => prisma.$queryRaw`SELECT 1`),
      timed(() => redis.ping()),
      timed(() => publicClient().getBlockNumber()),
      timed(async () => {
        const depths: Record<string, { waiting: number; active: number; failed: number }> = {};
        await Promise.all(
          Object.entries(queues).map(async ([name, q]) => {
            const c = await q.getJobCounts("waiting", "active", "failed", "delayed");
            depths[name] = { waiting: (c.waiting ?? 0) + (c.delayed ?? 0), active: c.active ?? 0, failed: c.failed ?? 0 };
          }),
        );
        return depths;
      }),
      timed(() => getEthPriceUsd()),
      solanaEnabled() ? timed(() => adapterFor("pump_fun").currentBlock()) : Promise.resolve(null),
    ]);
    const ok = dbCheck.ok && redisCheck.ok && rpcCheck.ok;
    res.status(ok ? 200 : 503);
    sendCached(
      res,
      {
        ok,
        version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.npm_package_version ?? "dev",
        uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
        services: {
          db: { ok: dbCheck.ok, latencyMs: dbCheck.latencyMs },
          redis: { ok: redisCheck.ok, latencyMs: redisCheck.latencyMs },
          rpc: { ok: rpcCheck.ok, latencyMs: rpcCheck.latencyMs, blockNumber: rpcCheck.value === null ? null : Number(rpcCheck.value) },
          solana: solana ? { ok: solana.ok, latencyMs: solana.latencyMs, slot: solana.value, cluster: env.SOLANA_CLUSTER } : null,
          queues: { ok: queueCheck.ok, depths: queueCheck.value ?? {} },
        },
        chain: { chainId: env.CHAIN_ID, ethPriceUsd: price.value ?? 0 },
        updatedAt: new Date().toISOString(),
      },
      { maxAge: 5, swr: 15 },
    );
  }),
);

const ReportBody = z
  .object({
    appId: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    reporter: z.string().min(3).max(120),
    kind: z.enum(["ABUSE", "DMCA", "IMPERSONATION", "OTHER"]),
    details: z.string().min(10).max(4000),
  })
  .refine((b) => b.appId || b.slug, { message: "appId or slug required" });

publicRoutes.post(
  "/reports",
  wrap(async (req, res) => {
    const body = parse(ReportBody, req.body);
    const app = await prisma.app.findUnique({ where: body.appId ? { id: body.appId } : { slug: body.slug! } });
    if (!app) throw new HttpError(404, "app_not_found");
    const report = await prisma.$transaction(async (tx) => {
      const r = await tx.report.create({
        data: { appId: app.id, reporter: body.reporter, kind: body.kind, details: body.details },
      });
      await tx.abuseFlag.create({
        data: { appId: app.id, source: "REPORT", category: body.kind, reason: `${body.details.slice(0, 500)} (report ${r.id})` },
      });
      return r;
    });
    res.status(201).json({ id: report.id });
  }),
);
