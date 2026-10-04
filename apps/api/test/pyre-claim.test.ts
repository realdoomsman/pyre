import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The staker-rewards claim: a $PYRE staker converts their accrued `earnedMicros` (summed across
 * active, non-withdrawn stakes) into an ETH payout from the treasury, without unstaking. The
 * take-then-pay guard is the load-bearing part — each claim must take a stake's earnings exclusively
 * before paying, restore them by INCREMENT if the transfer provably failed (a sweep may have credited
 * more in between), and leave them taken when the broadcast's receipt could not be read (it may still
 * mine; reconcile settles it). Everything below the HTTP layer is faked; the stake table is an
 * in-memory store with Postgres READ COMMITTED semantics: a plain read never blocks, and an UPDATE's
 * WHERE is evaluated against the latest committed row.
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

interface StakeWhere {
  id?: string | { in: string[] };
  earnedMicros?: bigint | { gt?: bigint; gte?: bigint };
}
type EarnedWrite = bigint | { increment?: bigint; decrement?: bigint };
interface StakeWrite {
  where: StakeWhere;
  data: { earnedMicros: EarnedWrite };
}

const fx = vi.hoisted(() => {
  const stakes: { rows: StakeRow[] } = { rows: [] };
  /** Claims whose reads are held until all of them have read: N concurrent transactions see the same pre-claim rows. */
  const race: { readers: number; waiting: Array<() => void> } = { readers: 1, waiting: [] };
  const state: { ethPriceUsd: number; transfer: "ok" | "failed" | "unconfirmed"; duringTransfer?: () => void } = { ethPriceUsd: 2000, transfer: "ok" };
  const captured: { ledger: LedgerData[] } = { ledger: [] };
  const HASH = "0x" + "c3".repeat(32);
  class TransactionUnconfirmedError extends Error {
    constructor(readonly hash: string) {
      super(`transaction ${hash} broadcast but unconfirmed`);
    }
  }
  const matches = (row: StakeRow, where: StakeWhere): boolean => {
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (typeof where.id === "object" && !where.id.in.includes(row.id)) return false;
    const e = where.earnedMicros;
    if (typeof e === "bigint" && row.earnedMicros !== e) return false;
    if (typeof e === "object" && e.gt !== undefined && !(row.earnedMicros > e.gt)) return false;
    if (typeof e === "object" && e.gte !== undefined && !(row.earnedMicros >= e.gte)) return false;
    return true;
  };
  const write = (current: bigint, w: EarnedWrite): bigint =>
    typeof w === "bigint" ? w : current + (w.increment ?? 0n) - (w.decrement ?? 0n);
  return {
    stakes,
    race,
    state,
    captured,
    HASH,
    TransactionUnconfirmedError,
    getEthPriceUsd: vi.fn(async () => state.ethPriceUsd),
    transferEth: vi.fn(async (_from: unknown, _to: string, _wei: bigint) => {
      state.duringTransfer?.();
      if (state.transfer === "failed") throw new Error("rpc down");
      if (state.transfer === "unconfirmed") throw new TransactionUnconfirmedError(HASH);
      return HASH;
    }),
    findMany: vi.fn(async () => {
      const snapshot = stakes.rows.filter((s) => s.earnedMicros > 0n).map((s) => ({ ...s }));
      await new Promise<void>((resolve) => {
        race.waiting.push(resolve);
        if (race.waiting.length >= race.readers) for (const release of race.waiting.splice(0)) release();
      });
      return snapshot;
    }),
    updateMany: vi.fn(async ({ where, data }: StakeWrite) => {
      let count = 0;
      for (const row of stakes.rows) {
        if (!matches(row, where)) continue;
        row.earnedMicros = write(row.earnedMicros, data.earnedMicros);
        count++;
      }
      return { count };
    }),
    stakeUpdate: vi.fn(async ({ where, data }: StakeWrite) => {
      const row = stakes.rows.find((s) => matches(s, where));
      if (!row) throw new Error("record not found");
      row.earnedMicros = write(row.earnedMicros, data.earnedMicros);
      return { ...row };
    }),
    createMany: vi.fn(async (p?: { data: LedgerData[] }) => {
      captured.ledger.push(...(p?.data ?? []));
      return { count: p?.data.length ?? 0 };
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
  pyreBurnDto: () => ({}),
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
const earned = (id: string): bigint | undefined => fx.stakes.rows.find((s) => s.id === id)?.earnedMicros;
/** `n` claims by the same user whose transactions all read before any of them writes. */
const concurrentClaims = (n: number): Promise<PromiseSettledResult<void>[]> => {
  fx.race.readers = n;
  return Promise.allSettled(Array.from({ length: n }, () => claimStakerRewardsHandler(req(), res().r)));
};

beforeEach(() => {
  fx.stakes.rows = [];
  fx.race.readers = 1;
  fx.race.waiting = [];
  fx.captured.ledger = [];
  fx.state.ethPriceUsd = 2000;
  fx.state.transfer = "ok";
  fx.state.duringTransfer = undefined;
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
    expect(earned("s1")).toBe(0n);
    expect(earned("s2")).toBe(0n);

    const ledger = fx.captured.ledger;
    const stakerTotal = ledger.filter((e) => e.account.startsWith("STAKERS:")).reduce((a, e) => a + e.deltaMicros, 0n);
    expect(stakerTotal).toBe(-5_000_000n);
    expect(ledger).toContainEqual(expect.objectContaining({ account: "STAKERS:app1", deltaMicros: -3_000_000n }));
    expect(ledger).toContainEqual(expect.objectContaining({ account: "STAKERS:app2", deltaMicros: -2_000_000n }));
    expect(ledger).toContainEqual(expect.objectContaining({ account: "TREASURY", deltaMicros: -5_000_000n }));

    expect(c.body).toMatchObject({ usdMicros: "5000000", wei: "2500000000000000", txHash: "0x" + "c3".repeat(32) });
  });

  it("pays an accrued balance once when concurrent claims race on it", async () => {
    fx.stakes.rows = [
      { id: "s1", appId: "app1", earnedMicros: 3_000_000n },
      { id: "s2", appId: "app2", earnedMicros: 2_000_000n },
    ];
    const outcomes = await concurrentClaims(4);

    // Production 2026-09-23: up to six simultaneous claims each paid the same balance.
    expect(fx.transferEth).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    for (const o of outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected")) {
      expect(o.reason).toMatchObject({ status: 400, message: "nothing_to_claim" });
    }
    expect(earned("s1")).toBe(0n);
    expect(earned("s2")).toBe(0n);
    expect(fx.captured.ledger.filter((e) => e.account === "TREASURY").reduce((a, e) => a + e.deltaMicros, 0n)).toBe(-5_000_000n);
  });

  it("never grows a below-floor balance when concurrent claims are rejected", async () => {
    fx.stakes.rows = [{ id: "s1", appId: "app1", earnedMicros: 500_000n }];

    // Two racing rejected claims used to restore the same dust twice, doubling it; ten rounds took
    // a $0.0012 accrual past the $1 floor (1193 µ$ credited, 1_221_632 = 1193 × 2^10 paid out).
    for (let round = 0; round < 2; round++) {
      const outcomes = await concurrentClaims(2);
      for (const o of outcomes) expect(o).toMatchObject({ status: "rejected", reason: { status: 400, message: "nothing_to_claim" } });
    }
    expect(earned("s1")).toBe(500_000n);

    fx.race.readers = 1;
    await expect(claimStakerRewardsHandler(req(), res().r)).rejects.toMatchObject({ status: 400, message: "nothing_to_claim" });
    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(earned("s1")).toBe(500_000n);
  });

  it("pays only what it took and leaves a share a sweep credited after the read", async () => {
    fx.stakes.rows = [{ id: "s1", appId: "app1", earnedMicros: 3_000_000n }];
    fx.findMany.mockImplementationOnce(async () => {
      const snapshot = fx.stakes.rows.map((s) => ({ ...s }));
      fx.stakes.rows[0]!.earnedMicros += 40_000n; // fee sweep commits between the claim's read and its take
      return snapshot;
    });
    const { r, c } = res();
    await claimStakerRewardsHandler(req(), r);

    expect(c.body).toMatchObject({ usdMicros: "3000000" });
    expect(earned("s1")).toBe(40_000n);
  });

  it("restores each stake's earnings by increment and writes no ledger when the payout provably failed", async () => {
    fx.stakes.rows = [
      { id: "s1", appId: "app1", earnedMicros: 3_000_000n },
      { id: "s2", appId: "app2", earnedMicros: 2_000_000n },
    ];
    fx.state.transfer = "failed";
    // A fee sweep lands while the payout is in flight: the restore must not overwrite its share.
    fx.state.duringTransfer = () => {
      fx.stakes.rows[0]!.earnedMicros += 100n;
    };
    const { r } = res();
    await expect(claimStakerRewardsHandler(req(), r)).rejects.toMatchObject({ status: 502, message: "claim_payout_failed" });

    expect(earned("s1")).toBe(3_000_100n);
    expect(earned("s2")).toBe(2_000_000n);
    expect(fx.createMany).not.toHaveBeenCalled();
  });

  it("leaves the earnings cleared and records the hash for reconcile when the payout was broadcast but unconfirmed", async () => {
    fx.stakes.rows = [{ id: "s1", appId: "app1", earnedMicros: 3_000_000n }];
    fx.state.transfer = "unconfirmed";
    const { r } = res();
    await expect(claimStakerRewardsHandler(req(), r)).rejects.toMatchObject({ status: 502, message: "claim_unconfirmed", extra: { txHash: fx.HASH } });

    // Restoring here would let the staker claim again while the first payout may still mine.
    expect(earned("s1")).toBe(0n);
    expect(fx.createMany).not.toHaveBeenCalled();
    expect(fx.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_UNCONFIRMED",
        targetType: "User",
        targetId: "u1",
        meta: expect.objectContaining({ kind: "PYRE_CLAIM", txHash: fx.HASH, stakes: [{ id: "s1", appId: "app1", earnedMicros: "3000000" }] }),
      }),
    );
  });

  it("rejects a claim below the $1 floor, keeping earnings and paying nothing", async () => {
    fx.stakes.rows = [{ id: "s1", appId: "app1", earnedMicros: 500_000n }];
    const { r } = res();
    await expect(claimStakerRewardsHandler(req(), r)).rejects.toMatchObject({ status: 400, message: "nothing_to_claim", extra: { claimableMicros: "500000" } });

    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(earned("s1")).toBe(500_000n);
  });

  it("requires a wallet on the account", async () => {
    const { r } = res();
    await expect(claimStakerRewardsHandler(req({ ...USER, wallet: null }), r)).rejects.toMatchObject({ status: 400, message: "wallet_required" });
    expect(fx.findMany).not.toHaveBeenCalled();
  });
});
