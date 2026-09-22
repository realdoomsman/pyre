import type * as Db from "@pyre/db";
import { FEE_SPLIT_BPS, bps, splitFees, usdMicrosFromWei } from "@pyre/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fee sweep is where on-chain ETH becomes off-chain money. `recordCreatorFee` must write the
 * split it computed into exactly one FeeEvent, credit the build budget, and mirror every part in
 * the ledger; `sweepApp` must credit only what the escrow actually paid out, keyed on the claim
 * transaction, and leave the app wallet with nothing but its gas reserve.
 */

const feeEvent = { findUnique: vi.fn(), create: vi.fn() };
const app = { update: vi.fn() };
const pyreStake = { findMany: vi.fn(), update: vi.fn() };
const ledgerEntry = { createMany: vi.fn() };
const notification = { findFirst: vi.fn(), create: vi.fn() };
const prisma = {
  feeEvent,
  app,
  pyreStake,
  ledgerEntry,
  notification,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ feeEvent, app, pyreStake, ledgerEntry }),
};

const TREASURY = "0x00000000000000000000000000000000000000AA";
const APP_WALLET = "0x00000000000000000000000000000000000000BB";
const TOKEN = "0x1111111111111111111111111111111111111111";
const chain = {
  readLaunch: vi.fn(),
  accruingFees: vi.fn(),
  sweepCreatorFees: vi.fn(),
  claimEscrow: vi.fn(),
  getEthBalance: vi.fn(),
  getEthPriceUsd: vi.fn(),
  transferEth: vi.fn(),
  treasury: () => ({ address: TREASURY, account: { address: TREASURY } }),
  deriveAppWallet: () => ({ address: APP_WALLET, account: { address: APP_WALLET } }),
};
const publishEvent = vi.fn();

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma }));
vi.mock("@pyre/chain", () => chain);
vi.mock("../src/workers/chain/env.js", () => ({ chainWorkerEnv: () => ({}) }));
vi.mock("../src/workers/chain/publish.js", () => ({ publishGlobal: vi.fn(), publishEvent }));
vi.mock("../src/workers/chain/launchState.js", () => ({ syncLaunchPhase: vi.fn() }));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/lock.js", () => ({ withLock: vi.fn() }));

// Dynamic imports: the module binds `@pyre/db` and `@pyre/chain` at load time, so it must come after the mocks.
const { dec } = await import("@pyre/db");
const { recordCreatorFee, sweepApp } = await import("../src/workers/chain/feeSweep.js");
const { APP_GAS_RESERVE_WEI } = await import("../src/workers/chain/wallet.js");

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = { redis: {}, log } as never;
const ETH_PRICE = 4000;
const CLAIM_TX = "0x" + "ab".repeat(32);

const sweepApp_ = (over: Record<string, unknown> = {}) =>
  ({
    id: "app1",
    launcherId: "user1",
    status: "LIVE",
    keypairIndex: 7,
    walletAddress: APP_WALLET,
    tokenAddress: TOKEN,
    launchPhase: 0,
    poolId: null,
    graduatedAt: null,
    unsweptWei: dec(0n),
    escrowWei: dec(0n),
    launcher: { id: "user1", wallet: null },
    forkOf: null,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  feeEvent.findUnique.mockResolvedValue(null);
  feeEvent.create.mockImplementation(async ({ data }: { data: { source: string } }) => ({ id: data.source === "FORK_ROYALTY" ? "fee_royalty" : "fee1", ...data }));
  app.update.mockResolvedValue({ budgetMicros: 123n });
  pyreStake.findMany.mockResolvedValue([]);
  notification.findFirst.mockResolvedValue({ id: "n1" });
});

describe("recordCreatorFee", () => {
  it("writes one FeeEvent with the wei, the price and the 60/25/15 split, credits the budget and mirrors the ledger", async () => {
    const wei = 500_000_000_000_000_000n; // 0.5 ETH → $2,000
    const credit = await recordCreatorFee(sweepApp_(), wei, CLAIM_TX as never, ETH_PRICE, log as never);

    const usdMicros = usdMicrosFromWei(wei, ETH_PRICE);
    const split = splitFees(usdMicros, false, false);
    expect(usdMicros).toBe(2_000_000_000n);
    expect(credit).toEqual({ feeEventId: "fee1", budgetMicros: 123n, buildMicros: split.buildMicros, usdMicros });
    const { stakersMicros: _stakers, ...written } = split;
    expect(feeEvent.create).toHaveBeenCalledTimes(1);
    expect(feeEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ appId: "app1", source: "CREATOR_FEE", wei: dec(wei), ethPriceUsd: ETH_PRICE, txHash: CLAIM_TX, ...written }),
    });
    expect(app.update).toHaveBeenCalledWith({
      where: { id: "app1" },
      data: { budgetMicros: { increment: split.buildMicros }, feesWei: { increment: dec(wei) } },
      select: { budgetMicros: true },
    });
    const rows = ledgerEntry.createMany.mock.calls[0]![0].data as Array<{ account: string; deltaMicros: bigint; refId: string }>;
    const byAccount = Object.fromEntries(rows.map((r) => [r.account, r.deltaMicros]));
    expect(byAccount).toEqual({
      "BUILD:app1": split.buildMicros,
      PYRE_TOKEN: split.pyreMicros,
      "LAUNCHER:user1": split.launcherMicros,
      "CREDITS:app1": split.creditsMicros,
    });
    expect(rows.every((r) => r.refId === "fee1")).toBe(true);
    // Every dollar of the claim lands in exactly one ledger bucket.
    expect(rows.reduce((s, r) => s + r.deltaMicros, 0n)).toBe(usdMicros);
    expect(byAccount["BUILD:app1"]! + byAccount["CREDITS:app1"]!).toBe(bps(usdMicros, FEE_SPLIT_BPS.BUILD_BUDGET));
  });

  it("is idempotent on the claim transaction", async () => {
    feeEvent.findUnique.mockResolvedValue({ id: "fee-existing" });
    const credit = await recordCreatorFee(sweepApp_(), 1n, CLAIM_TX as never, ETH_PRICE, log as never);
    expect(credit).toBeNull();
    expect(feeEvent.create).not.toHaveBeenCalled();
    expect(app.update).not.toHaveBeenCalled();
    expect(ledgerEntry.createMany).not.toHaveBeenCalled();
  });

  it("routes a fork's royalty upstream as a second FeeEvent with proportional wei and a BUILD credit for the parent", async () => {
    const wei = 1_000_000_000_000_000_000n; // 1 ETH → $4,000
    await recordCreatorFee(sweepApp_({ forkOf: { id: "parent", status: "LIVE" } }), wei, CLAIM_TX as never, ETH_PRICE, log as never);

    const usdMicros = usdMicrosFromWei(wei, ETH_PRICE);
    const split = splitFees(usdMicros, true, false);
    expect(feeEvent.create).toHaveBeenCalledTimes(2);
    expect(feeEvent.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ appId: "parent", source: "FORK_ROYALTY", usdMicros: split.upstreamMicros, buildMicros: split.upstreamMicros, wei: dec((wei * split.upstreamMicros) / usdMicros) }),
    });
    expect(app.update).toHaveBeenCalledWith({ where: { id: "parent" }, data: { budgetMicros: { increment: split.upstreamMicros } } });
    const rows = ledgerEntry.createMany.mock.calls[0]![0].data as Array<{ account: string; deltaMicros: bigint; refId: string }>;
    expect(rows).toContainEqual(expect.objectContaining({ account: "BUILD:parent", deltaMicros: split.upstreamMicros, refId: "fee_royalty" }));
  });

  it("does not pay a royalty to a killed parent", async () => {
    await recordCreatorFee(sweepApp_({ forkOf: { id: "parent", status: "KILLED" } }), 1_000_000_000_000_000_000n, CLAIM_TX as never, ETH_PRICE, log as never);
    expect(feeEvent.create).toHaveBeenCalledTimes(1);
    expect(feeEvent.create.mock.calls[0]![0].data.upstreamMicros).toBe(0n);
  });
});

describe("sweepApp", () => {
  const launch = { token: TOKEN, curve: "0xc0", phase: 0, exists: true, poolId: "0x", creatorFeeRecipient: APP_WALLET };

  it("sweeps, claims, credits the claimed wei keyed on the claim tx, moves the excess to the treasury and snapshots what is still accruing", async () => {
    chain.readLaunch.mockResolvedValue(launch);
    chain.accruingFees.mockResolvedValueOnce({ unsweptWei: 10n, escrowWei: 0n }).mockResolvedValueOnce({ unsweptWei: 3n, escrowWei: 0n });
    chain.getEthBalance.mockResolvedValueOnce(APP_GAS_RESERVE_WEI); // gas check: no top-up needed
    chain.sweepCreatorFees.mockResolvedValue({ swept: true, hash: "0xsweep" });
    const claimedWei = 250_000_000_000_000_000n;
    chain.claimEscrow.mockResolvedValue({ hash: CLAIM_TX, wei: claimedWei });
    chain.getEthPriceUsd.mockResolvedValue(ETH_PRICE);
    chain.getEthBalance.mockResolvedValueOnce(APP_GAS_RESERVE_WEI + claimedWei); // after the claim
    chain.transferEth.mockResolvedValue("0xmove");

    await sweepApp(ctx, sweepApp_(), log as never);

    expect(chain.sweepCreatorFees).toHaveBeenCalledWith(expect.objectContaining({ address: APP_WALLET }), launch);
    expect(feeEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ wei: dec(claimedWei), txHash: CLAIM_TX, ethPriceUsd: ETH_PRICE }) });
    expect(publishEvent).toHaveBeenCalledWith(prisma, {}, "app1", expect.objectContaining({ type: "FEES", wei: claimedWei.toString(), txHash: CLAIM_TX }));
    expect(chain.transferEth).toHaveBeenCalledWith(expect.objectContaining({ address: APP_WALLET }), TREASURY, claimedWei);
    expect(app.update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { unsweptWei: dec(3n), escrowWei: dec(0n) } });
  });

  it("credits nothing and moves nothing when the escrow owes nothing", async () => {
    chain.readLaunch.mockResolvedValue(launch);
    chain.accruingFees.mockResolvedValue({ unsweptWei: 0n, escrowWei: 0n });
    chain.claimEscrow.mockResolvedValue({ wei: 0n });
    chain.getEthBalance.mockResolvedValue(APP_GAS_RESERVE_WEI);

    await sweepApp(ctx, sweepApp_(), log as never);

    expect(chain.sweepCreatorFees).not.toHaveBeenCalled();
    expect(feeEvent.create).not.toHaveBeenCalled();
    expect(chain.transferEth).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("revives a DORMANT app once the credited budget clears the iteration minimum", async () => {
    chain.readLaunch.mockResolvedValue(launch);
    chain.accruingFees.mockResolvedValue({ unsweptWei: 0n, escrowWei: 5n });
    chain.getEthBalance.mockResolvedValue(APP_GAS_RESERVE_WEI);
    chain.sweepCreatorFees.mockResolvedValue({ swept: false, reason: "nothing-to-sweep" });
    chain.claimEscrow.mockResolvedValue({ hash: CLAIM_TX, wei: 5n });
    chain.getEthPriceUsd.mockResolvedValue(ETH_PRICE);
    app.update.mockResolvedValue({ budgetMicros: 10_000_000n });

    await sweepApp(ctx, sweepApp_({ status: "DORMANT" }), log as never);

    expect(app.update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { status: "LIVE" } });
    expect(publishEvent).toHaveBeenCalledWith(prisma, {}, "app1", expect.objectContaining({ type: "REVIVED", by: "creator fees" }));
  });
});
