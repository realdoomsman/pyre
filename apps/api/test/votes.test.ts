import { big, type Decimalish } from "@pyre/db";
import { CONTRIBUTOR_MIN_HOLD_BPS, PUMP_TOTAL_SUPPLY, VOTE_WALLET_CAP_BPS } from "@pyre/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Governance weight. Token-weighted voting with a per-wallet cap is the only thing stopping a
 * whale from owning an app's roadmap, so the cap, the submission floor and the election threshold
 * are pinned here against an in-memory holder table.
 */

interface HolderRow {
  appId: string;
  wallet: string;
  amount: bigint;
}

const holders: HolderRow[] = [];

/** Prisma filters arrive as `Prisma.Decimal` (the column is `Decimal(78, 0)`); rows are kept as bigint. */
interface AmountFilter {
  gt?: Decimalish;
  lte?: Decimalish;
}

const matches = (row: HolderRow, where: { appId: string; amount?: AmountFilter }): boolean => {
  if (row.appId !== where.appId) return false;
  const amount = where.amount;
  if (amount?.gt !== undefined && !(row.amount > big(amount.gt))) return false;
  if (amount?.lte !== undefined && !(row.amount <= big(amount.lte))) return false;
  return true;
};

vi.mock("@pyre/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prisma: {
    holderBalance: {
      findUnique: async ({ where }: { where: { appId_wallet: { appId: string; wallet: string } } }) =>
        holders.find((h) => h.appId === where.appId_wallet.appId && h.wallet === where.appId_wallet.wallet) ?? null,
      count: async ({ where }: { where: { appId: string; amount?: AmountFilter } }) => holders.filter((h) => matches(h, where)).length,
      aggregate: async ({ where }: { where: { appId: string; amount?: AmountFilter } }) => ({
        _sum: { amount: holders.filter((h) => matches(h, where)).reduce((acc, h) => acc + h.amount, 0n) },
      }),
    },
  },
}));
vi.mock("@pyre/chain", () => ({ getErc20Balance: async () => 0n }));
vi.mock("../src/lib/cache.js", () => ({ cached: <T,>(_k: unknown, _ttl: unknown, fn: () => Promise<T>) => fn() }));

import { SUPPLY_BASE_UNITS, cappedElectorate, contributorMinHold, holderBalance, holderWallet, isElected, voteCap, voteWeight, type GovApp } from "../src/lib/votes.js";

const APP: GovApp = { id: "app_gov", chain: "robinhood", launchpad: "pons_v2" };
const PUMP_APP: GovApp = { id: "app_pump", chain: "solana", launchpad: "pump_fun" };
const VOTE_CAP = voteCap(APP);
const QUEUE_MIN_HOLD = contributorMinHold(APP);

beforeEach(() => {
  holders.length = 0;
});

const hold = (wallet: string, amount: bigint, appId = APP.id): void => {
  holders.push({ appId, wallet, amount });
};

describe("cap and floor constants", () => {
  it("derive from the venue's supply and basis points, not hardcoded token counts", () => {
    expect(VOTE_CAP).toBe((SUPPLY_BASE_UNITS * BigInt(VOTE_WALLET_CAP_BPS)) / 10_000n);
    expect(QUEUE_MIN_HOLD).toBe((SUPPLY_BASE_UNITS * BigInt(CONTRIBUTOR_MIN_HOLD_BPS)) / 10_000n);
    // 2% of 1B tokens with 18 decimals for both the cap and the contributor floor.
    expect(VOTE_CAP).toBe(20_000_000n * 10n ** 18n);
    expect(QUEUE_MIN_HOLD).toBe(20_000_000n * 10n ** 18n);
  });

  it("scale with the coin's own supply on pump.fun (6 decimals), so the same 2% gate applies", () => {
    expect(voteCap(PUMP_APP)).toBe((PUMP_TOTAL_SUPPLY * BigInt(VOTE_WALLET_CAP_BPS)) / 10_000n);
    expect(voteCap(PUMP_APP)).toBe(20_000_000n * 10n ** 6n);
    expect(contributorMinHold(PUMP_APP)).toBe(20_000_000n * 10n ** 6n);
  });

  it("keys the holder snapshot by the viewer's wallet on the coin's chain", () => {
    const user = { wallet: "0xabc", solWallet: "So1ana" };
    expect(holderWallet(APP, user)).toBe("0xabc");
    expect(holderWallet(PUMP_APP, user)).toBe("So1ana");
    expect(holderWallet(PUMP_APP, { wallet: "0xabc", solWallet: null })).toBeNull();
  });
});

describe("voteWeight", () => {
  it("is the raw balance below the cap", async () => {
    hold("whale_free", VOTE_CAP - 1n);
    hold("minnow", 1_000_000n);
    expect(await voteWeight(APP, "whale_free")).toBe(VOTE_CAP - 1n);
    expect(await voteWeight(APP, "minnow")).toBe(1_000_000n);
  });

  it("clamps exactly at the cap, not one base unit later", async () => {
    hold("at_cap", VOTE_CAP);
    hold("over_cap", VOTE_CAP + 1n);
    expect(await voteWeight(APP, "at_cap")).toBe(VOTE_CAP);
    expect(await voteWeight(APP, "over_cap")).toBe(VOTE_CAP);
  });

  it("caps a whale holding the entire supply to 2%", async () => {
    hold("whale", SUPPLY_BASE_UNITS);
    const weight = await voteWeight(APP, "whale");
    expect(weight).toBe(VOTE_CAP);
    expect(weight * 50n).toBe(SUPPLY_BASE_UNITS);
  });

  it("is zero for an unknown wallet, a wallet on another app, and a signed-in user with no wallet", async () => {
    hold("holder", VOTE_CAP, "other_app");
    expect(await voteWeight(APP, "holder")).toBe(0n);
    expect(await voteWeight(APP, "never_seen")).toBe(0n);
    expect(await voteWeight(APP, null)).toBe(0n);
    expect(await holderBalance(APP.id, null)).toBe(0n);
  });

  it("caps a pump.fun whale at 2% of the 6-decimal supply", async () => {
    hold("sol_whale", PUMP_TOTAL_SUPPLY, PUMP_APP.id);
    expect(await voteWeight(PUMP_APP, "sol_whale")).toBe(voteCap(PUMP_APP));
    expect(await voteWeight(PUMP_APP, "sol_whale")).toBeLessThan(VOTE_CAP);
  });

  it("does not let a dust holder pass the prompt-queue submission floor", async () => {
    hold("dust", QUEUE_MIN_HOLD - 1n);
    hold("eligible", QUEUE_MIN_HOLD);
    expect((await holderBalance(APP.id, "dust")) >= QUEUE_MIN_HOLD).toBe(false);
    expect((await holderBalance(APP.id, "eligible")) >= QUEUE_MIN_HOLD).toBe(true);
    // Submitting requires the floor, but voting only requires a non-zero capped weight.
    expect(await voteWeight(APP, "dust")).toBe(QUEUE_MIN_HOLD - 1n);
  });
});

describe("cappedElectorate", () => {
  it("counts every over-cap holder as exactly one cap", async () => {
    hold("whale_a", SUPPLY_BASE_UNITS / 2n);
    hold("whale_b", SUPPLY_BASE_UNITS / 4n);
    hold("small", 500n);
    expect(await cappedElectorate(APP)).toBe(VOTE_CAP * 2n + 500n);
  });

  it("is zero with no holders and ignores other apps", async () => {
    expect(await cappedElectorate(APP)).toBe(0n);
    hold("holder", 10n, "other_app");
    expect(await cappedElectorate(APP)).toBe(0n);
  });

  it("treats an exactly-at-cap holder as uncapped, counting them once and only once", async () => {
    hold("at_cap", VOTE_CAP);
    // The `gt` / `lte` split must partition the holders: double counting here would halve every
    // majority threshold in the product.
    expect(await cappedElectorate(APP)).toBe(VOTE_CAP);
  });

  it("stays consistent with the sum of individual capped weights", async () => {
    const amounts = [1n, 999n, QUEUE_MIN_HOLD, VOTE_CAP - 1n, VOTE_CAP, VOTE_CAP + 1n, SUPPLY_BASE_UNITS / 3n];
    amounts.forEach((amount, i) => hold(`w${i}`, amount));
    const summed = (await Promise.all(amounts.map((_, i) => voteWeight(APP, `w${i}`)))).reduce((a, b) => a + b, 0n);
    expect(await cappedElectorate(APP)).toBe(summed);
  });
});

describe("isElected", () => {
  it("requires more than half: exactly 50% is not a majority", () => {
    expect(isElected(50n, 100n)).toBe(false);
    expect(isElected(51n, 100n)).toBe(true);
    expect(isElected(49n, 100n)).toBe(false);
  });

  it("handles odd electorates without rounding a loser into a winner", () => {
    expect(isElected(50n, 101n)).toBe(false);
    expect(isElected(51n, 101n)).toBe(true);
    expect(isElected(1n, 1n)).toBe(true);
    expect(isElected(1n, 2n)).toBe(false);
  });

  it("never elects anyone from an empty or unsupported electorate", () => {
    expect(isElected(0n, 0n)).toBe(false);
    expect(isElected(5n, 0n)).toBe(false);
    expect(isElected(0n, 100n)).toBe(false);
  });

  it("is decided by a single base unit at whole-supply scale", () => {
    const half = SUPPLY_BASE_UNITS / 2n;
    expect(isElected(half, SUPPLY_BASE_UNITS)).toBe(false);
    expect(isElected(half + 1n, SUPPLY_BASE_UNITS)).toBe(true);
    // One base unit is 0.000001 tokens out of a billion: the comparison must stay in bigint.
    expect(isElected(half + 1n, SUPPLY_BASE_UNITS - 2n)).toBe(true);
  });

  it("means a single capped whale cannot elect a maintainer against 50 small holders", async () => {
    hold("whale", SUPPLY_BASE_UNITS);
    for (let i = 0; i < 50; i++) hold(`holder_${i}`, VOTE_CAP);
    const electorate = await cappedElectorate(APP);
    const whaleWeight = await voteWeight(APP, "whale");
    expect(isElected(whaleWeight, electorate)).toBe(false);
    // It takes 26 of the 51 capped voters to elect: 25 is exactly under half.
    expect(isElected(VOTE_CAP * 25n, electorate)).toBe(false);
    expect(isElected(VOTE_CAP * 26n, electorate)).toBe(true);
  });
});
