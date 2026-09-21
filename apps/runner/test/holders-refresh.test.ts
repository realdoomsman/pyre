import type * as Db from "@pyre/db";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `HolderBalance` is the electorate: governance vote weight and the holder-tier
 * gate are both computed from those rows. The explorer path replaces the whole
 * snapshot per app, so an empty response — an unindexed token, a rate-limited
 * call, a transient error — must never wipe a populated snapshot. The log path
 * folds `Transfer` deltas into the stored balances and must commit the cursor
 * with them, never counting protocol-owned balances as holders.
 */

const holderBalance = { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), upsert: vi.fn() };
const app = { findMany: vi.fn(), update: vi.fn() };
const platformSetting = { findUnique: vi.fn(), upsert: vi.fn() };
const prisma = {
  app,
  holderBalance,
  platformSetting,
  $transaction: async (fn: (tx: unknown) => Promise<void>) => fn({ app, holderBalance, platformSetting }),
};

const getHolders = vi.fn();
const getLogs = vi.fn();
const getBlockNumber = vi.fn();
const readLaunch = vi.fn();
const CURVE = getAddress("0x00000000000000000000000000000000000000c0");
const LOCKER = getAddress("0x00000000000000000000000000000000000000d0");
const chainEnv: { BLOCKSCOUT_API_KEY?: string } = {};

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma }));
vi.mock("@pyre/chain", () => ({
  getHolders,
  readLaunch,
  publicClient: () => ({ getLogs, getBlockNumber }),
  ponsAddresses: () => ({ locker: LOCKER, poolManager: "0x00000000000000000000000000000000000000e0", buybackVault: "0x00000000000000000000000000000000000000f0" }),
  DEAD_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  LOG_CHUNK_BLOCKS: 10_000n,
  tokenAbi: [{ type: "event", name: "Transfer", inputs: [] }],
}));
vi.mock("../src/workers/chain/env.js", () => ({ chainWorkerEnv: () => chainEnv }));
vi.mock("../src/workers/chain/publish.js", () => ({ publishGlobal: vi.fn(), publishEvent: vi.fn() }));
vi.mock("../src/lib/lock.js", () => ({
  withLock: async (_r: unknown, _k: string, _t: number, fn: () => Promise<void>) => {
    await fn();
    return { acquired: true as const, value: undefined };
  },
}));

// Dynamic import: the module reads `@pyre/db` and `@pyre/chain` at load time, so
// it must be imported AFTER `vi.mock` registers those doubles.
const { dec } = await import("@pyre/db");
const { runHolderRefresh } = await import("../src/workers/chain/holders.js");

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = { redis: {}, log } as never;
const TOKEN = "0x1111111111111111111111111111111111111111";
const W1 = "0x2222222222222222222222222222222222222222";
const W2 = "0x3333333333333333333333333333333333333333";
const holder = (address: string, units: bigint, system: string | null = null) => ({ address, units, share: 0, system });

beforeEach(() => {
  vi.clearAllMocks();
  delete chainEnv.BLOCKSCOUT_API_KEY;
});

describe("explorer snapshot (BLOCKSCOUT_API_KEY set)", () => {
  beforeEach(() => {
    chainEnv.BLOCKSCOUT_API_KEY = "pro-key";
  });

  it("keeps the previous snapshot when the explorer returns nothing for a coin that has holders", async () => {
    app.findMany.mockResolvedValue([{ id: "a1", tokenAddress: TOKEN, holdersCount: 1213, launchBlock: 1n }]);
    getHolders.mockResolvedValue([]);

    await runHolderRefresh(ctx);

    expect(holderBalance.deleteMany).not.toHaveBeenCalled();
    expect(app.update).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("writes the new snapshot and counts only non-system rows as holders", async () => {
    app.findMany.mockResolvedValue([{ id: "a1", tokenAddress: TOKEN, holdersCount: 1, launchBlock: 1n }]);
    getHolders.mockResolvedValue([holder(CURVE, 900n, "curve"), holder(W1, 5n), holder(W2, 7n)]);

    await runHolderRefresh(ctx);

    expect(holderBalance.deleteMany).toHaveBeenCalledWith({ where: { appId: "a1" } });
    expect(holderBalance.createMany).toHaveBeenCalledWith({
      data: [
        { appId: "a1", wallet: CURVE, amount: dec(900n) },
        { appId: "a1", wallet: W1, amount: dec(5n) },
        { appId: "a1", wallet: W2, amount: dec(7n) },
      ],
    });
    expect(app.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { holdersCount: 2 } });
  });

  it("accepts an empty snapshot for a coin that already had none", async () => {
    app.findMany.mockResolvedValue([{ id: "a1", tokenAddress: TOKEN, holdersCount: 0, launchBlock: 1n }]);
    getHolders.mockResolvedValue([]);

    await runHolderRefresh(ctx);

    expect(holderBalance.deleteMany).toHaveBeenCalledWith({ where: { appId: "a1" } });
    expect(app.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { holdersCount: 0 } });
  });

  it("a failure on one app does not stop the rest of the pass", async () => {
    app.findMany.mockResolvedValue([
      { id: "a1", tokenAddress: TOKEN, holdersCount: 3, launchBlock: 1n },
      { id: "a2", tokenAddress: TOKEN, holdersCount: 0, launchBlock: 1n },
    ]);
    getHolders.mockRejectedValueOnce(new Error("429 rate limited")).mockResolvedValueOnce([holder(W1, 9n)]);

    await runHolderRefresh(ctx);

    expect(app.update).toHaveBeenCalledTimes(1);
    expect(app.update).toHaveBeenCalledWith({ where: { id: "a2" }, data: { holdersCount: 1 } });
  });
});

describe("transfer-log indexing (no explorer key)", () => {
  const transfer = (from: string, to: string, value: bigint) => ({ args: { from, to, value } });
  const ZERO = "0x0000000000000000000000000000000000000000";

  it("starts at the launch block, folds deltas, skips system balances and commits the cursor", async () => {
    app.findMany.mockResolvedValue([{ id: "a1", tokenAddress: TOKEN, holdersCount: 0, launchBlock: 100n }]);
    platformSetting.findUnique.mockResolvedValue(null);
    getBlockNumber.mockResolvedValue(150n);
    readLaunch.mockResolvedValue({ curve: CURVE });
    getLogs.mockResolvedValue([
      transfer(ZERO, CURVE, 1_000n), // mint to the curve
      transfer(CURVE, W1, 100n), // W1 buys
      transfer(CURVE, W2, 50n), // W2 buys
      transfer(W2, W1, 50n), // W2 sells out to W1
      transfer(W1, LOCKER, 10n), // locked supply
    ]);

    await runHolderRefresh(ctx);

    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs.mock.calls[0]![0]).toMatchObject({ address: TOKEN, fromBlock: 100n, toBlock: 150n });
    expect(holderBalance.findMany).not.toHaveBeenCalled(); // first pass builds from scratch
    expect(holderBalance.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { amount: dec(140n) }, where: { appId_wallet: { appId: "a1", wallet: W1 } } }));
    expect(holderBalance.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { amount: dec(850n) }, where: { appId_wallet: { appId: "a1", wallet: CURVE } } }));
    expect(holderBalance.deleteMany).toHaveBeenCalledWith({ where: { appId: "a1", wallet: W2 } });
    expect(app.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { holdersCount: 1 } });
    expect(platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { key: "holdersCursor:a1", value: "150" } }));
  });

  it("resumes from the stored cursor on top of the stored balances", async () => {
    app.findMany.mockResolvedValue([{ id: "a1", tokenAddress: TOKEN, holdersCount: 1, launchBlock: 100n }]);
    platformSetting.findUnique.mockResolvedValue({ key: "holdersCursor:a1", value: "150" });
    holderBalance.findMany.mockResolvedValue([{ wallet: W1, amount: dec(140n) }]);
    getBlockNumber.mockResolvedValue(160n);
    readLaunch.mockResolvedValue({ curve: CURVE });
    getLogs.mockResolvedValue([transfer(W1, W2, 40n)]);

    await runHolderRefresh(ctx);

    expect(getLogs.mock.calls[0]![0]).toMatchObject({ fromBlock: 151n, toBlock: 160n });
    expect(holderBalance.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { amount: dec(100n) }, where: { appId_wallet: { appId: "a1", wallet: W1 } } }));
    expect(holderBalance.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { amount: dec(40n) }, where: { appId_wallet: { appId: "a1", wallet: W2 } } }));
    expect(app.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { holdersCount: 2 } });
  });

  it("does nothing when the cursor is already at the head", async () => {
    app.findMany.mockResolvedValue([{ id: "a1", tokenAddress: TOKEN, holdersCount: 1, launchBlock: 100n }]);
    platformSetting.findUnique.mockResolvedValue({ key: "holdersCursor:a1", value: "160" });
    getBlockNumber.mockResolvedValue(160n);

    await runHolderRefresh(ctx);

    expect(getLogs).not.toHaveBeenCalled();
    expect(app.update).not.toHaveBeenCalled();
  });
});
