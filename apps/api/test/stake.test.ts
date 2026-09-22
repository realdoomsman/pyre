import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Hash } from "viem";

/**
 * Launch stake settlement. The stake is spam control, so what matters is that only a real transfer
 * of ≥ the chain's stake into the treasury on that chain settles a launch: an external hash must
 * verify on chain (to/value/from), a hash cannot settle two launches, and the custodial path debits
 * the launcher's own wallet on the app's chain only when it can also still pay gas. External stakes
 * are bound to the wallet proven at login, which only exists on Robinhood Chain, so a Solana launch
 * is custodial-only. The venue adapter is injected; no I/O.
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
  adapterFor: () => {
    throw new Error("adapter must be injected in this test");
  },
  solanaEnabled: () => true,
  deriveWallet: () => ({ address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", account: { address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA" } }),
  getEthBalance: vi.fn(),
  getErc20Balance: vi.fn(),
  usdgAddress: () => "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: { address: "0x0000000000000000000000000000000000000001" } }),
}));
vi.mock("../src/lib/events.js", () => ({ publishEvent: vi.fn() }));
vi.mock("../src/lib/queues.js", () => ({ queues: {} }));

import { settleStake, type StakeChain } from "../src/lib/launch.js";
import { LAUNCH_STAKE_BY_CHAIN, LAUNCH_STAKE_WEI } from "@pyre/shared";

const TREASURY = "0x0000000000000000000000000000000000000001";
const EXTERNAL = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const HASH = ("0x" + "ab".repeat(32)) as Hash;
const APP = { id: "app1", chain: "robinhood" as const, launchpad: "pons_v2" as const };
const USER = { id: "u1", wallet: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", authWallet: EXTERNAL, walletIndex: 5 };

const SOL_TREASURY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SOL_USER_WALLET = "So1anaUser111111111111111111111111111111111";
const SOL_SIG = "5wHu1qwD4E3vTd9nJqvUeYtWuDL1yiLFJVXDQzVdYc3PtLHRZAx9y1n2Cz3wVn3nS4eZfLPaJRBk6eZB4bHzAYS";
const SOL_APP = { id: "app2", chain: "solana" as const, launchpad: "pump_fun" as const };
const SOL_STAKE = LAUNCH_STAKE_BY_CHAIN.solana;

type Fake = StakeChain & { verifyNativeTransfer: Mock; transferNative: Mock };

const chain = (over: Partial<StakeChain> = {}): Fake => ({
  treasury: () => ({ chain: "robinhood", address: TREASURY, signer: {} }),
  userWallet: () => ({ chain: "robinhood", address: USER.wallet, signer: {} }),
  verifyNativeTransfer: vi.fn(async () => ({ ok: true, from: EXTERNAL, amount: LAUNCH_STAKE_WEI })),
  transferNative: vi.fn(async () => ({ hash: HASH, block: 1 })),
  nativeBalance: async () => LAUNCH_STAKE_WEI * 2n,
  ...over,
});

const solChain = (over: Partial<StakeChain> = {}): Fake => ({
  treasury: () => ({ chain: "solana", address: SOL_TREASURY, signer: {} }),
  userWallet: () => ({ chain: "solana", address: SOL_USER_WALLET, signer: {} }),
  verifyNativeTransfer: vi.fn(async () => ({ ok: true, from: SOL_USER_WALLET, amount: SOL_STAKE })),
  transferNative: vi.fn(async () => ({ hash: SOL_SIG, block: 300_000_000 })),
  nativeBalance: async () => SOL_STAKE * 2n,
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
    expect(c.verifyNativeTransfer).toHaveBeenCalledWith(HASH, TREASURY, LAUNCH_STAKE_WEI, EXTERNAL);
    expect(out).toEqual({ txHash: HASH, wei: LAUNCH_STAKE_WEI, from: EXTERNAL, custodial: false });
    expect(c.transferNative).not.toHaveBeenCalled();
  });

  it("refuses an external hash from a launcher without a proven wallet (any inbound treasury tx would otherwise be claimable)", async () => {
    const c = chain();
    await expect(settleStake(APP, { ...USER, authWallet: null }, { txHash: HASH }, c)).rejects.toMatchObject({ status: 400, message: "external_wallet_required" });
    expect(c.verifyNativeTransfer).not.toHaveBeenCalled();
  });

  it("refuses an external hash on Solana even with a proven EVM wallet: nothing binds the sender to the launcher there", async () => {
    const c = solChain();
    await expect(settleStake(SOL_APP, USER, { txHash: HASH }, c)).rejects.toMatchObject({ status: 400, message: "external_wallet_required" });
    expect(c.verifyNativeTransfer).not.toHaveBeenCalled();
  });

  it("credits exactly LAUNCH_STAKE_WEI when the transfer overpays, so the refund never exceeds the stake", async () => {
    const c = chain({ verifyNativeTransfer: vi.fn(async () => ({ ok: true, from: EXTERNAL, amount: LAUNCH_STAKE_WEI * 500n })) });
    const out = await settleStake(APP, USER, { txHash: HASH }, c);
    expect(out.wei).toBe(LAUNCH_STAKE_WEI);
  });

  it("rejects a transfer whose sender is the treasury (a fee sweep / drain is not a stake)", async () => {
    const c = chain({ verifyNativeTransfer: vi.fn(async () => ({ ok: true, from: TREASURY, amount: LAUNCH_STAKE_WEI })) });
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
    const c = chain({ verifyNativeTransfer: vi.fn(async () => ({ ok: false, from: EXTERNAL, amount: 1n, reason: "insufficient" })) });
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
    expect(c.verifyNativeTransfer).not.toHaveBeenCalled();
  });
});

describe("custodial stake ({custodial:true})", () => {
  it("debits exactly LAUNCH_STAKE_WEI from the launcher's custodial wallet to the treasury", async () => {
    const c = chain();
    const out = await settleStake(APP, USER, { custodial: true }, c);
    expect(c.transferNative).toHaveBeenCalledTimes(1);
    expect(c.transferNative.mock.calls[0]?.slice(1)).toEqual([TREASURY, LAUNCH_STAKE_WEI]);
    expect(out).toMatchObject({ txHash: HASH, wei: LAUNCH_STAKE_WEI, from: USER.wallet, custodial: true });
  });

  it("blocks the debit when the wallet cannot cover stake + gas reserve, before any transfer", async () => {
    const c = chain({ nativeBalance: async () => LAUNCH_STAKE_WEI });
    await expect(settleStake(APP, USER, { custodial: true }, c)).rejects.toMatchObject({ status: 400, message: "insufficient_balance" });
    expect(c.transferNative).not.toHaveBeenCalled();
  });

  it("maps a failed transfer to 502 stake_failed", async () => {
    const c = chain({ transferNative: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    await expect(settleStake(APP, USER, { custodial: true }, c)).rejects.toMatchObject({ status: 502, message: "stake_failed" });
  });

  it("requires a custodial wallet", async () => {
    await expect(settleStake(APP, { ...USER, wallet: null }, { custodial: true }, chain())).rejects.toMatchObject({ status: 400, message: "wallet_required" });
  });

  it("stakes 1 SOL from the launcher's Solana wallet to the Solana treasury on a pump.fun launch, recording the base58 signature", async () => {
    const c = solChain();
    const out = await settleStake(SOL_APP, USER, { custodial: true }, c);
    expect(c.transferNative).toHaveBeenCalledTimes(1);
    const [account, to, amount] = c.transferNative.mock.calls[0]!;
    expect(account).toMatchObject({ chain: "solana", address: SOL_USER_WALLET });
    expect([to, amount]).toEqual([SOL_TREASURY, SOL_STAKE]);
    expect(out).toEqual({ txHash: SOL_SIG, wei: SOL_STAKE, from: SOL_USER_WALLET, custodial: true });
  });

  it("keeps the Solana rent-exempt reserve: exactly 1 SOL in the wallet is not enough", async () => {
    const c = solChain({ nativeBalance: async () => SOL_STAKE });
    await expect(settleStake(SOL_APP, USER, { custodial: true }, c)).rejects.toMatchObject({ status: 400, message: "insufficient_balance", extra: { to: SOL_TREASURY } });
    expect(c.transferNative).not.toHaveBeenCalled();
  });
});
