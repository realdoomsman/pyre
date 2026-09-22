import type * as Db from "@pyre/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The market indexer's two data-loss guards: (1) a graduated launch is scanned on BOTH venues
 * while the cursor is still behind the tip, because a backfill range can precede or straddle
 * the graduation block and curve fills skipped there are gone once the cursor moves; (2) the
 * cursor advances only after the candles are stored, so a failed candle write replays the range
 * instead of leaving a permanent hole in the chart.
 */

interface CandleUpsertArgs {
  where: { appId_interval_t: { appId: string; interval: string; t: number } };
  update: { o: number; h: number; l: number; c: number; v: number };
}

const fx = vi.hoisted(() => {
  const app = { findMany: vi.fn(), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) };
  const trade = { createMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []) };
  const candle = { upsert: vi.fn<(args: CandleUpsertArgs) => Promise<unknown>>(async () => ({})), aggregate: vi.fn(async () => ({ _sum: { v: 0 } })) };
  const prisma = { app, trade, candle, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ app, trade, candle }) };
  return { app, trade, candle, prisma, getTrades: vi.fn<(launch: { phase: number }, from: bigint, to: bigint) => Promise<unknown[]>>(), readLaunch: vi.fn(), getBlockNumber: vi.fn() };
});

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma: fx.prisma }));
vi.mock("@pyre/chain", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTrades: fx.getTrades,
  readLaunch: fx.readLaunch,
  getEthPriceUsd: async () => 2000,
  publicClient: () => ({ getBlockNumber: fx.getBlockNumber }),
}));
vi.mock("../src/workers/chain/launchState.js", () => ({ syncLaunchPhase: vi.fn() }));
vi.mock("../src/workers/chain/publish.js", () => ({ publishGlobal: vi.fn(), publishEvent: vi.fn() }));
vi.mock("../src/lib/lock.js", () => ({
  withLock: async (_r: unknown, _k: string, _t: number, fn: () => Promise<void>) => {
    await fn();
    return { acquired: true as const, value: undefined };
  },
}));

// Dynamic import: the module binds `@pyre/db` and `@pyre/chain` at load time, so it must come after the mocks.
const { runMarketRefresh } = await import("../src/workers/chain/market.js");

const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL_LAUNCH = { exists: true, phase: 2, token: TOKEN, curve: "0x00000000000000000000000000000000000000c0", poolId: "0x" + "ab".repeat(32) };
const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = { redis: {}, log } as never;
const fill = (block: number) => ({ hash: `0x${block}`, block, ts: 1_700_000_000 + block, side: "buy" as const, wallet: "0x2222222222222222222222222222222222222222", tokenUnits: 10n ** 18n, quoteNative: 10n ** 15n, priceNative: 0.001 });
/** App row already flipped to POOL by an earlier pass, cursor at 1000. */
const graduatedApp = { id: "a1", chain: "robinhood" as const, launchpad: "pons_v2" as const, tokenAddress: TOKEN, launchPhase: 2, poolId: POOL_LAUNCH.poolId, graduatedAt: new Date(), launchBlock: 1n, lastIndexedBlock: 1000n };

beforeEach(() => {
  vi.clearAllMocks();
  fx.readLaunch.mockResolvedValue(POOL_LAUNCH);
  fx.getTrades.mockResolvedValue([]);
  fx.app.findMany.mockResolvedValue([graduatedApp]);
});

describe("market indexer", () => {
  it("scans the curve as well as the pool while a graduated launch is still backfilling", async () => {
    fx.getBlockNumber.mockResolvedValue(1_000_000n); // far behind the tip: the 50k-block range may be entirely pre-graduation
    await runMarketRefresh(ctx);

    const phases = fx.getTrades.mock.calls.map((c) => c[0].phase).sort();
    expect(phases).toEqual([0, 2]);
    expect(fx.getTrades.mock.calls[0]![1]).toBe(1001n);
    expect(fx.getTrades.mock.calls[0]![2]).toBe(51_000n);
  });

  it("scans only the pool once the cursor reaches the tip", async () => {
    fx.getBlockNumber.mockResolvedValue(1_500n);
    await runMarketRefresh(ctx);

    expect(fx.getTrades).toHaveBeenCalledTimes(1);
    expect(fx.getTrades.mock.calls[0]![0].phase).toBe(2);
    expect(fx.app.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { lastIndexedBlock: 1_500n } });
  });

  it("advances the cursor only after the candles are written, so a failed candle write replays the range", async () => {
    fx.getBlockNumber.mockResolvedValue(1_500n);
    fx.getTrades.mockResolvedValue([fill(1200)]);
    fx.trade.findMany.mockResolvedValue([{ txHash: "0x1200", block: 1200n, ts: new Date((1_700_000_000 + 1200) * 1000), side: "BUY", wallet: fill(1200).wallet, tokenUnits: 10n ** 18n, quoteWei: 10n ** 15n, priceUsd: 2 }]);
    fx.candle.upsert.mockRejectedValueOnce(new Error("transaction timeout"));
    await runMarketRefresh(ctx);

    expect(fx.trade.createMany).toHaveBeenCalledTimes(1);
    expect(fx.app.update).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ appId: "a1" }), "market refresh failed for app");

    // Next pass: the trades are re-fetched from the same cursor, the candles rebuilt, and only then the cursor moves.
    vi.clearAllMocks();
    fx.readLaunch.mockResolvedValue(POOL_LAUNCH);
    fx.app.findMany.mockResolvedValue([graduatedApp]);
    fx.getBlockNumber.mockResolvedValue(1_500n);
    fx.getTrades.mockResolvedValue([fill(1200)]);
    fx.trade.findMany.mockResolvedValue([{ txHash: "0x1200", block: 1200n, ts: new Date((1_700_000_000 + 1200) * 1000), side: "BUY", wallet: fill(1200).wallet, tokenUnits: 10n ** 18n, quoteWei: 10n ** 15n, priceUsd: 2 }]);
    await runMarketRefresh(ctx);

    expect(fx.getTrades.mock.calls[0]![1]).toBe(1001n);
    expect(fx.candle.upsert).toHaveBeenCalled();
    // Rebuilt from the stored rows, not merged: the bucket's volume is the trade's, not doubled by the replay.
    const oneMinute = fx.candle.upsert.mock.calls.map((c) => c[0]).find((c) => c.where.appId_interval_t.interval === "1m");
    expect(oneMinute?.update.v).toBeCloseTo(2, 6); // 0.001 ETH × $2000
    expect(fx.app.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: expect.objectContaining({ lastIndexedBlock: 1_500n }) });
  });
});
