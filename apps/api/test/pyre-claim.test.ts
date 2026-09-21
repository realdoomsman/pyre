import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The staker-rewards claim: a $PYRE staker converts their accrued `earnedMicros` (summed across
 * active, non-withdrawn stakes) into an ETH payout from the treasury, without unstaking. The
 * read-and-clear-then-pay guard is the load-bearing part — earnings are zeroed inside a transaction
 * so a concurrent claim cannot double-pay, restored by INCREMENT if the transfer provably failed
 * (a sweep may have credited more in between), and left cleared when the broadcast's receipt could
 * not be read (it may still mine; reconcile settles it). Everything below the HTTP layer is faked.
 */

interface StakeRow {
  id: string;
  appId: string;
  earnedMicros: bigint;
}

interface LedgerData {
  account: string;
  deltaMicros: bigint;
  refType?: string;
  refId?: string;
  memo?: string;
}

const fx = vi.hoisted(() => {
  const stakes: { rows: StakeRow[] } = { rows: [] };
  const state: { ethPriceUsd: number; transfer: "ok" | "failed" | "unconfirmed" } = { ethPriceUsd: 2000, transfer: "ok" };
  const captured: { ledger: LedgerData[] } = { ledger: [] };
  const HASH = "0x" + "c3".repeat(32);
  class TransactionUnconfirmedError extends Error {
    constructor(readonly hash: string) {
      super(`transaction ${hash} broadcast but unconfirmed`);
    }
  }
  return {
    stakes,
    state,
    captured,
    HASH,
    TransactionUnconfirmedError,
    getEthPriceUsd: vi.fn(async () => state.ethPriceUsd),
    transferEth: vi.fn(async (_from: unknown, _to: string, _wei: bigint) => {
      if (state.transfer === "failed") throw new Error("rpc down");
      if (state.transfer === "unconfirmed") throw new TransactionUnconfirmedError(HASH);
      return HASH;
    }),
    findMany: vi.fn(async () => stakes.rows.map((s) => ({ ...s }))),
    updateMany: vi.fn(async () => ({ count: stakes.rows.length })),
    stakeUpdate: vi.fn(async (_p?: { where: { id: string }; data: { earnedMicros: { increment: bigint } } }) => ({})),
    createMany: vi.fn(async (p?: { data: LedgerData[] }) => {
      captured.ledger = p?.data ?? [];
      return { count: captured.ledger.length };
    }),
    writeAudit: vi.fn(async () => undefined),
  };
});

vi.mock("@pyre/db", () => ({
  prisma: {
    $transaction: async (cb: (tx: { pyreStake: { findMany: typeof fx.findMany; updateMany: typeof fx.updateMany } }) => unknown) =>
      cb({ pyreStake: { findMany: fx.findMany, updateMany: fx.updateMany } }),
    pyreStake: { update: fx.stakeUpdate },
    ledgerEntry: { createMany: fx.createMany },
  },
}));
vi.mock("@pyre/chain", () => ({
  getEthPriceUsd: fx.getEthPriceUsd,
  transferEth: fx.transferEth,
  transferErc20: vi.fn(),
  TransactionUnconfirmedError: fx.TransactionUnconfirmedError,
  explorerTxUrl: (h: string) => `https://explorer.test/tx/${h}`,
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: { address: "0x0000000000000000000000000000000000000001" } }),
}));
vi.mock("../src/lib/audit.js", () => ({ writeAudit: fx.writeAudit }));
vi.mock("../src/lib/dto.js", () => ({
  pctOfSupply: () => 0,
  stakeDto: () => ({}),
  buybackDto: () => ({}),
  BUYBACK_INCLUDE: {},
}));
vi.mock("../src/lib/metrics.js", () => ({ db: {} }));
vi.mock("../src/lib/cache.js", () => ({ APPS_TAG: "apps", cached: <T,>(_k: unknown, _ttl: unknown, fn: () => Promise<T>) => fn() }));
vi.mock("../src/lib/http.js", () => ({ sendCached: () => undefined }));
vi.mock("../src/lib/market.js", () => ({ marketSnapshot: async () => null }));
vi.mock("../src/lib/votes.js", () => ({ PLATFORM_PROPOSAL_MIN_HOLD: 0n, pyreBalance: async () => 0n }));
vi.mock("../src/lib/custodial.js", () => ({
  custodialAccount: vi.fn(),
  custodialEthBalance: vi.fn(),
  GAS_RESERVE_WEI: 0n,
}));

import { claimStakerRewardsHandler } from "../src/routes/pyre.js";

interface TestUser {
  id: string;
  wallet: string | null;
  walletIndex: number;
  reputation: number;
}
const USER: TestUser = { id: "u1", wallet: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", walletIndex: 5, reputation: 0 };
const req = (user: TestUser = USER): Request => ({ body: {}, user }) as unknown as Request;
const res = (): { r: Response; c: { status: number; body: unknown } } => {
  const c = { status: 200, body: undefined as unknown };
  const r = {
    status(code: number) { c.status = code; return r; },
    json(p: unknown) { c.body = p; return r; },
    setHeader() { return r; },
  } as unknown as Response;
  return { r, c };
};

beforeEach(() => {
  fx.stakes.rows = [];
  fx.captured.ledger = [];
  fx.state.ethPriceUsd = 2000;
  fx.state.transfer = "ok";
  for (const f of [fx.getEthPriceUsd, fx.transferEth, fx.findMany, fx.updateMany, fx.stakeUpdate, fx.createMany, fx.writeAudit]) f.mockClear();
});

describe("claimStakerRewards", () => {
  it("pays the summed earnings from the treasury, clears them, and balances the books", async () => {
    fx.stakes.rows = [
      { id: "s1", appId: "app1", earnedMicros: 3_000_000n },
      { id: "s2", appId: "app2", earnedMicros: 2_000_000n },
    ];
    const { r, c } = res();
    await claimStakerRewardsHandler(req(), r);

    // $5 at $2000/ETH = 0.0025 ETH, paid from the treasury account to the caller's custodial wallet.
    expect(fx.transferEth).toHaveBeenCalledTimes(1);
    expect(fx.transferEth.mock.calls[0]?.[0]).toMatchObject({ address: "0x0000000000000000000000000000000000000001" });
    expect(fx.transferEth.mock.calls[0]?.[1]).toBe(USER.wallet);
    expect(fx.transferEth.mock.calls[0]?.[2]).toBe(2_500_000_000_000_000n);

    expect(fx.updateMany).toHaveBeenCalledTimes(1);
    expect((fx.updateMany.mock.calls[0] as unknown[])?.[0]).toMatchObject({ data: { earnedMicros: 0n } });

    expect(fx.createMany).toHaveBeenCalledTimes(1);
    const ledger = fx.captured.ledger;
    const stakerTotal = ledger.filter((e) => e.account.startsWith("STAKERS:")).reduce((a, e) => a + e.deltaMicros, 0n);
    expect(stakerTotal).toBe(-5_000_000n);
    expect(ledger).toContainEqual(expect.objectContaining({ account: "STAKERS:app1", deltaMicros: -3_000_000n }));
    expect(ledger).toContainEqual(expect.objectContaining({ account: "STAKERS:app2", deltaMicros: -2_000_000n }));
    expect(ledger).toContainEqual(expect.objectContaining({ account: "TREASURY", deltaMicros: -5_000_000n }));

    expect(c.body).toMatchObject({ usdMicros: "5000000", wei: "2500000000000000", txHash: "0x" + "c3".repeat(32) });
  });

  it("restores each stake's earnings by increment and writes no ledger when the payout provably failed", async () => {
    fx.stakes.rows = [
      { id: "s1", appId: "app1", earnedMicros: 3_000_000n },
      { id: "s2", appId: "app2", earnedMicros: 2_000_000n },
    ];
    fx.state.transfer = "failed";
    const { r } = res();
    await expect(claimStakerRewardsHandler(req(), r)).rejects.toMatchObject({ status: 502, message: "claim_payout_failed" });

    // Increment, not set: a fee sweep landing between the clear and the restore must not be overwritten.
    expect(fx.stakeUpdate).toHaveBeenCalledTimes(2);
    expect((fx.stakeUpdate.mock.calls[0] as unknown[])?.[0]).toMatchObject({ where: { id: "s1" }, data: { earnedMicros: { increment: 3_000_000n } } });
    expect((fx.stakeUpdate.mock.calls[1] as unknown[])?.[0]).toMatchObject({ where: { id: "s2" }, data: { earnedMicros: { increment: 2_000_000n } } });
    expect(fx.createMany).not.toHaveBeenCalled();
  });

  it("leaves the earnings cleared and records the hash for reconcile when the payout was broadcast but unconfirmed", async () => {
    fx.stakes.rows = [{ id: "s1", appId: "app1", earnedMicros: 3_000_000n }];
    fx.state.transfer = "unconfirmed";
    const { r } = res();
    await expect(claimStakerRewardsHandler(req(), r)).rejects.toMatchObject({ status: 502, message: "claim_unconfirmed", extra: { txHash: fx.HASH } });

    // Restoring here would let the staker claim again while the first payout may still mine.
    expect(fx.stakeUpdate).not.toHaveBeenCalled();
    expect(fx.createMany).not.toHaveBeenCalled();
    expect(fx.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PAYOUT_UNCONFIRMED", targetType: "User", targetId: "u1", meta: expect.objectContaining({ kind: "PYRE_CLAIM", txHash: fx.HASH }) }),
    );
  });

  it("rejects a claim below the $1 floor, restoring earnings and paying nothing", async () => {
    fx.stakes.rows = [{ id: "s1", appId: "app1", earnedMicros: 500_000n }];
    const { r } = res();
    await expect(claimStakerRewardsHandler(req(), r)).rejects.toMatchObject({ status: 400, message: "nothing_to_claim" });

    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(fx.stakeUpdate).toHaveBeenCalledTimes(1);
    expect((fx.stakeUpdate.mock.calls[0] as unknown[])?.[0]).toMatchObject({ where: { id: "s1" }, data: { earnedMicros: { increment: 500_000n } } });
  });

  it("requires a wallet on the account", async () => {
    const { r } = res();
    await expect(claimStakerRewardsHandler(req({ ...USER, wallet: null }), r)).rejects.toMatchObject({ status: 400, message: "wallet_required" });
    expect(fx.findMany).not.toHaveBeenCalled();
  });
});
