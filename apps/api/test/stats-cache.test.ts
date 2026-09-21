import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MARKET_SNAPSHOT_KEY, type MarketSnapshot, type StatsDto } from "@pyre/shared";

/**
 * `/v1/stats` (and every app summary) is served from Postgres plus the runner-persisted market
 * snapshot row, cached for at most 30 s. The request path must never reach the RPC or a price
 * feed: a cold request used to block ~2.7 s on `getEthPriceUsd` + three `$PYRE` chain reads.
 * The `@pyre/chain` double below throws on every read so any regression fails loudly rather
 * than merely slowly.
 */

const chainCall = (name: string) => () => {
  throw new Error(`request path reached the chain: ${name}`);
};

const fx = vi.hoisted(() => {
  const snapshot: { row: { key: string; value: unknown } | null } = { row: null };
  const cacheCalls: Array<{ key: string; ttlMs: number }> = [];
  const chain = {
    getEthPriceUsd: vi.fn(),
    readLaunch: vi.fn(),
    getPrice: vi.fn(),
    getTokenInfo: vi.fn(),
    publicClient: vi.fn(),
  };
  return { snapshot, cacheCalls, chain };
});

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<object>()), prisma: {} }));
vi.mock("@pyre/chain", () => ({
  ...fx.chain,
  DEAD_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  ponsAddresses: () => ({ poolManager: "0x1", locker: "0x2", buybackVault: "0x3" }),
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: {} }),
}));
vi.mock("../src/lib/metrics.js", () => {
  const agg = async () => ({ _sum: { revenueMicros: 0n, feesWei: null, buybackWei: null, usdMicros: 0n, ethWei: null } });
  const count = async () => 0;
  return {
    db: {
      $transaction: async (ops: unknown[]) => Promise.all(ops),
      app: { aggregate: agg, count },
      revenueEvent: { aggregate: agg },
      buyback: { aggregate: agg, count },
      buildJob: { findMany: async () => [] },
      platformSetting: { findUnique: async ({ where }: { where: { key: string } }) => (fx.snapshot.row?.key === where.key ? fx.snapshot.row : null) },
    },
  };
});
vi.mock("../src/lib/cache.js", () => ({
  APPS_TAG: "apps",
  cacheKey: (...p: unknown[]) => p.join(":"),
  cached: <T,>(key: string, ttlMs: number, fn: () => Promise<T>) => {
    fx.cacheCalls.push({ key, ttlMs });
    return fn();
  },
}));
vi.mock("../src/lib/redis.js", () => ({ redis: {} }));
vi.mock("../src/lib/queues.js", () => ({ queues: {} }));
vi.mock("../src/routes/apps.js", () => ({ listCounts: async () => ({}) }));

import { MARKET_SNAPSHOT_TTL_MS } from "../src/lib/market.js";
import { publicRoutes, STATS_TTL_MS } from "../src/routes/public.js";

type Router = { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (e?: unknown) => void) => unknown }> } }> };

const getStats = async (): Promise<StatsDto> => {
  const layer = (publicRoutes as unknown as Router).stack.find((l) => l.route?.path === "/stats" && l.route.methods.get);
  if (!layer?.route) throw new Error("no GET /stats");
  let resolve: (body: StatsDto) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const done = new Promise<StatsDto>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const res = {
    status: () => res,
    json: (p: StatsDto) => {
      resolve(p);
      return res;
    },
    setHeader: () => res,
    type: () => res,
    req: { headers: {} },
  } as unknown as Response;
  layer.route.stack[0]!.handle({ query: {}, body: {}, params: {}, headers: {} } as Request, res, (e?: unknown) => reject(e ?? new Error("next() without error")));
  return done;
};

const SNAPSHOT: MarketSnapshot = {
  ethPriceUsd: 3210.5,
  pyreToken: {
    address: "0x1111111111111111111111111111111111111111",
    name: "Pyre",
    symbol: "PYRE",
    phase: 2,
    curveAddress: "0x2222222222222222222222222222222222222222",
    poolId: "0x" + "ab".repeat(32),
    progress: 1,
    priceUsd: 0.0042,
    priceEth: 0.0000013,
    mcapUsd: 4_200_000,
    totalSupplyUnits: "1000000000000000000000000000",
    burnedUnits: "10000000000000000000000000",
  },
  updatedAt: "2026-09-21T08:00:00.000Z",
};

beforeEach(() => {
  fx.snapshot.row = null;
  fx.cacheCalls.length = 0;
  for (const [name, spy] of Object.entries(fx.chain)) spy.mockReset().mockImplementation(chainCall(name));
});

describe("GET /v1/stats", () => {
  it("serves the ETH price and $PYRE figures from the runner's snapshot row without any chain call", async () => {
    fx.snapshot.row = { key: MARKET_SNAPSHOT_KEY, value: SNAPSHOT };

    const body = await getStats();

    expect(body.ethPriceUsd).toBe(3210.5);
    expect(body.pyreToken).toMatchObject({ address: SNAPSHOT.pyreToken!.address, priceUsd: 0.0042, mcapUsd: 4_200_000, burnedUnits: SNAPSHOT.pyreToken!.burnedUnits, burnedPct: 1 });
    for (const spy of Object.values(fx.chain)) expect(spy).not.toHaveBeenCalled();
  });

  it("degrades to 'not yet' before the runner's first pass, still without touching the chain", async () => {
    const body = await getStats();

    expect(body.ethPriceUsd).toBe(0);
    expect(body.pyreToken).toBeNull();
    for (const spy of Object.values(fx.chain)) expect(spy).not.toHaveBeenCalled();
  });

  it("caches the response and the snapshot for at most 30 s", async () => {
    fx.snapshot.row = { key: MARKET_SNAPSHOT_KEY, value: SNAPSHOT };
    await getStats();

    expect(STATS_TTL_MS).toBeLessThanOrEqual(30_000);
    expect(MARKET_SNAPSHOT_TTL_MS).toBeLessThanOrEqual(30_000);
    expect(fx.cacheCalls).toContainEqual({ key: "stats", ttlMs: STATS_TTL_MS });
    expect(fx.cacheCalls).toContainEqual({ key: "market.snapshot", ttlMs: MARKET_SNAPSHOT_TTL_MS });
  });
});
