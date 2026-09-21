import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Address, Hash } from "viem";

/**
 * Launch stake settlement. The stake is spam control, so what matters is that only a real transfer
 * of ≥ LAUNCH_STAKE_WEI into the treasury settles a launch: an external hash must verify on chain
 * (to/value/from), a hash cannot settle two launches, and the custodial path debits the launcher's
 * own wallet only when it can also still pay gas. The chain is injected; no I/O.
 */

const fx = vi.hoisted(() => ({
  findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  userFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
}));

vi.mock("@pyre/db", () => ({
  prisma: { app: { findFirst: fx.findFirst }, user: { findFirst: fx.userFindFirst } },
  Prisma: { PrismaClientKnownRequestError: class {} },
}));
vi.mock("@pyre/chain", () => ({
  deriveAppWallet: () => ({ address: "0x2222222222222222222222222222222222222222" }),
  deriveWallet: () => ({ address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", account: { address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA" } }),
  transferEth: vi.fn(),
  verifyEthTransfer: vi.fn(),
  getEthBalance: vi.fn(),
  getErc20Balance: vi.fn(),
  usdgAddress: () => "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: { address: "0x0000000000000000000000000000000000000001" } }),
}));
vi.mock("../src/lib/events.js", () => ({ publishEvent: vi.fn() }));
vi.mock("../src/lib/queues.js", () => ({ queues: {} }));

import { settleStake, type StakeChain } from "../src/lib/launch.js";
import { LAUNCH_STAKE_WEI } from "@pyre/shared";

const TREASURY = "0x0000000000000000000000000000000000000001" as Address;
const EXTERNAL = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const HASH = ("0x" + "ab".repeat(32)) as Hash;
const APP = { id: "app1" };
const USER = { id: "u1", wallet: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", authWallet: EXTERNAL, walletIndex: 5 };

const chain = (over: Partial<StakeChain> = {}): StakeChain & { verifyEthTransfer: Mock; transferEth: Mock } => ({
  verifyEthTransfer: vi.fn(async () => ({ ok: true, from: EXTERNAL, wei: LAUNCH_STAKE_WEI })),
  transferEth: vi.fn(async () => HASH),
  ethBalance: async () => LAUNCH_STAKE_WEI * 2n,
  ...over,
});

beforeEach(() => {
  fx.findFirst.mockReset();
  fx.findFirst.mockResolvedValue(null);
  fx.userFindFirst.mockReset();
  fx.userFindFirst.mockResolvedValue(null);
});

describe("external stake ({txHash})", () => {
  it("verifies the hash against the treasury, the stake amount and the launcher's proven wallet", async () => {
    const c = chain();
    const out = await settleStake(APP, USER, { txHash: HASH }, c);
    expect(c.verifyEthTransfer).toHaveBeenCalledWith(HASH, { to: TREASURY, minWei: LAUNCH_STAKE_WEI, from: EXTERNAL });
    expect(out).toEqual({ txHash: HASH, wei: LAUNCH_STAKE_WEI, from: EXTERNAL, custodial: false });
    expect(c.transferEth).not.toHaveBeenCalled();
  });

  it("refuses an external hash from a launcher without a proven wallet (any inbound treasury tx would otherwise be claimable)", async () => {
    const c = chain();
    await expect(settleStake(APP, { ...USER, authWallet: null }, { txHash: HASH }, c)).rejects.toMatchObject({ status: 400, message: "external_wallet_required" });
    expect(c.verifyEthTransfer).not.toHaveBeenCalled();
  });

  it("credits exactly LAUNCH_STAKE_WEI when the transfer overpays, so the refund never exceeds the stake", async () => {
    const c = chain({ verifyEthTransfer: vi.fn(async () => ({ ok: true, from: EXTERNAL, wei: LAUNCH_STAKE_WEI * 500n })) });
    const out = await settleStake(APP, USER, { txHash: HASH }, c);
    expect(out.wei).toBe(LAUNCH_STAKE_WEI);
  });

  it("rejects a transfer whose sender is the treasury (a fee sweep / drain is not a stake)", async () => {
    const c = chain({ verifyEthTransfer: vi.fn(async () => ({ ok: true, from: TREASURY, wei: LAUNCH_STAKE_WEI })) });
    await expect(settleStake(APP, { ...USER, authWallet: TREASURY }, { txHash: HASH }, c)).rejects.toMatchObject({
      status: 400,
      message: "stake_tx_invalid",
      extra: { reason: "platform-sender" },
    });
  });

  it("rejects a transfer whose sender is a custodial or app wallet", async () => {
    fx.userFindFirst.mockResolvedValue({ id: "someone" });
    const c = chain();
    await expect(settleStake(APP, USER, { txHash: HASH }, c)).rejects.toMatchObject({ status: 400, message: "stake_tx_invalid", extra: { reason: "platform-sender" } });
  });

  it("rejects an unverified transfer with the reason and the expected destination", async () => {
    const c = chain({ verifyEthTransfer: vi.fn(async () => ({ ok: false, from: EXTERNAL, wei: 1n, reason: "insufficient" })) });
    await expect(settleStake(APP, USER, { txHash: HASH }, c)).rejects.toMatchObject({
      status: 400,
      message: "stake_tx_invalid",
      extra: { reason: "insufficient", to: TREASURY },
    });
  });

  it("refuses a hash that already settled another launch", async () => {
    fx.findFirst.mockResolvedValue({ id: "other" });
    const c = chain();
    await expect(settleStake(APP, USER, { txHash: HASH }, c)).rejects.toMatchObject({ status: 409, message: "stake_tx_already_used" });
    expect(c.verifyEthTransfer).not.toHaveBeenCalled();
  });
});

describe("custodial stake ({custodial:true})", () => {
  it("debits exactly LAUNCH_STAKE_WEI from the launcher's custodial wallet to the treasury", async () => {
    const c = chain();
    const out = await settleStake(APP, USER, { custodial: true }, c);
    expect(c.transferEth).toHaveBeenCalledTimes(1);
    expect(c.transferEth.mock.calls[0]?.slice(1)).toEqual([TREASURY, LAUNCH_STAKE_WEI]);
    expect(out).toMatchObject({ txHash: HASH, wei: LAUNCH_STAKE_WEI, from: USER.wallet, custodial: true });
  });

  it("blocks the debit when the wallet cannot cover stake + gas reserve, before any transfer", async () => {
    const c = chain({ ethBalance: async () => LAUNCH_STAKE_WEI });
    await expect(settleStake(APP, USER, { custodial: true }, c)).rejects.toMatchObject({ status: 400, message: "insufficient_balance" });
    expect(c.transferEth).not.toHaveBeenCalled();
  });

  it("maps a failed transfer to 502 stake_failed", async () => {
    const c = chain({ transferEth: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    await expect(settleStake(APP, USER, { custodial: true }, c)).rejects.toMatchObject({ status: 502, message: "stake_failed" });
  });

  it("requires a custodial wallet", async () => {
    await expect(settleStake(APP, { ...USER, wallet: null }, { custodial: true }, chain())).rejects.toMatchObject({ status: 400, message: "wallet_required" });
  });
});
