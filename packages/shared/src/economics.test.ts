import { describe, expect, it } from "vitest";
import {
  FEE_SPLIT_BPS,
  FORK_ROYALTY_BPS,
  GLOBAL_DAILY_COMPUTE_CEILING_USD,
  ITERATION_BUDGET_USD,
  LAUNCH_STAKE_WEI,
  MIN_BUILD_BUDGET_USD,
  MIN_BUYBACK_USD,
  PLATFORM_PROPOSAL_MIN_HOLD_BPS,
  PONS_GRADUATION_THRESHOLD_WEI,
  PONS_LAUNCH_FEE_WEI,
  PONS_TOTAL_SUPPLY,
  PROMPT_QUEUE_MIN_HOLD_BPS,
  REVENUE_SPLIT_BPS,
  TOKEN_DECIMALS,
  VOTE_WALLET_CAP_BPS,
  WEI_PER_ETH,
  bps,
  splitFees,
  usdMicrosFromWei,
  weiFromUsdMicros,
} from "./index.js";

/** Deterministic PRNG so the property checks below are reproducible across machines and runs. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Amounts that actually occur: dust, single wei, whole ETH, and whale-sized sweeps. */
const randomAmounts = (count: number, seed: number): bigint[] => {
  const rand = mulberry32(seed);
  const out: bigint[] = [0n, 1n, 2n, 3n, 9999n, 10_000n, 10_001n, 1_000_000_000n];
  for (let i = out.length; i < count; i++) {
    const magnitude = 1 + Math.floor(rand() * 19); // 10^1 .. 10^19 wei/micros
    out.push(BigInt(Math.floor(rand() * 1e15)) * 10n ** BigInt(magnitude) + BigInt(Math.floor(rand() * 9973)));
  }
  return out;
};

describe("split tables", () => {
  it("fee split sums to exactly 10_000 bps", () => {
    const total = FEE_SPLIT_BPS.BUILD_BUDGET + FEE_SPLIT_BPS.PYRE_TOKEN + FEE_SPLIT_BPS.LAUNCHER;
    expect(total).toBe(10_000);
  });

  it("revenue split sums to exactly 10_000 bps", () => {
    const total = REVENUE_SPLIT_BPS.BUYBACK_BURN + REVENUE_SPLIT_BPS.PYRE_TOKEN + REVENUE_SPLIT_BPS.PLATFORM_OPS;
    expect(total).toBe(10_000);
  });

  it("every share is a positive share of the whole", () => {
    for (const share of [...Object.values(FEE_SPLIT_BPS), ...Object.values(REVENUE_SPLIT_BPS)]) {
      expect(share).toBeGreaterThan(0);
      expect(share).toBeLessThan(10_000);
    }
  });

  it("derived-cut tables stay inside the pool they are carved out of", () => {
    // Fork royalty is taken out of the build budget.
    expect(FORK_ROYALTY_BPS).toBeLessThan(FEE_SPLIT_BPS.BUILD_BUDGET);
    // A wallet cap above the submission floor is what makes governance meaningful.
    expect(PROMPT_QUEUE_MIN_HOLD_BPS).toBeLessThan(VOTE_WALLET_CAP_BPS);
  });

  it("budget thresholds are ordered so a first build can always fund at least one iteration", () => {
    expect(ITERATION_BUDGET_USD.MIN).toBeLessThanOrEqual(ITERATION_BUDGET_USD.DEFAULT);
    expect(ITERATION_BUDGET_USD.DEFAULT).toBeLessThanOrEqual(ITERATION_BUDGET_USD.MAX);
    expect(MIN_BUILD_BUDGET_USD).toBeGreaterThanOrEqual(ITERATION_BUDGET_USD.MIN);
    expect(GLOBAL_DAILY_COMPUTE_CEILING_USD).toBeGreaterThan(ITERATION_BUDGET_USD.MAX);
    expect(MIN_BUYBACK_USD).toBeGreaterThan(0);
  });
});

describe("bps()", () => {
  it("is exact on bigints far beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = 123_456_789_012_345_678_901_234_567_890n;
    expect(bps(huge, FEE_SPLIT_BPS.BUILD_BUDGET)).toBe((huge * 6000n) / 10_000n);
    // Float math on this amount is off by orders of magnitude; the bigint path must not be.
    expect(bps(huge, 10_000)).toBe(huge);
    expect(bps(huge, 0)).toBe(0n);
  });

  it("floors rather than rounding, so a split can never invent value", () => {
    expect(bps(1n, 5000)).toBe(0n);
    expect(bps(3n, 5000)).toBe(1n);
    expect(bps(9_999n, 10_000)).toBe(9_999n);
    expect(bps(10_001n, 1)).toBe(1n);
  });

  it("truncates fractional number inputs instead of rounding them up", () => {
    expect(bps(1.999, 10_000)).toBe(1n);
    expect(bps(10_000.75, 2500)).toBe(2500n);
  });

  it("never loses or invents a unit across the three-way fee split", () => {
    for (const amount of randomAmounts(400, 0x5719)) {
      const build = bps(amount, FEE_SPLIT_BPS.BUILD_BUDGET);
      const ship = bps(amount, FEE_SPLIT_BPS.PYRE_TOKEN);
      const launcher = amount - build - ship;
      expect(build + ship + launcher).toBe(amount);
      expect(launcher).toBeGreaterThanOrEqual(0n);
      // The remainder lands on the launcher cut, and is never more than the rounding dust.
      expect(launcher - bps(amount, FEE_SPLIT_BPS.LAUNCHER)).toBeLessThanOrEqual(2n);
    }
  });

  it("never loses or invents a micro across the three-way revenue split", () => {
    for (const amount of randomAmounts(400, 0xbeef)) {
      const buyback = bps(amount, REVENUE_SPLIT_BPS.BUYBACK_BURN);
      const ship = bps(amount, REVENUE_SPLIT_BPS.PYRE_TOKEN);
      const ops = amount - buyback - ship;
      expect(buyback + ship + ops).toBe(amount);
      expect(ops).toBeGreaterThanOrEqual(0n);
    }
  });

  it("shows why the last leg must be a remainder: three bps() calls can drop up to 2 units", () => {
    // 10_001 splits to 6000/2500/1500 -> 6000 + 2500 + 1500 = 10_000, one unit vanishes.
    const amount = 10_001n;
    const naive =
      bps(amount, FEE_SPLIT_BPS.BUILD_BUDGET) + bps(amount, FEE_SPLIT_BPS.PYRE_TOKEN) + bps(amount, FEE_SPLIT_BPS.LAUNCHER);
    expect(naive).toBeLessThan(amount);
    expect(amount - naive).toBe(1n);
  });
});

describe("fork royalty base", () => {
  it("is charged on the build cut, not on the gross fee", () => {
    const gross = 1_000_000_000n; // $1,000 in micros
    const build = bps(gross, FEE_SPLIT_BPS.BUILD_BUDGET);
    const royalty = bps(build, FORK_ROYALTY_BPS);
    // 10% of the 60% build cut == 6% of gross, i.e. 60_000_000 micros ($60) not $100.
    expect(royalty).toBe(bps(gross, 600));
    expect(royalty).toBeLessThan(bps(gross, FORK_ROYALTY_BPS));
    // The fork keeps the rest of its build budget; the royalty never eats the $PYRE or launcher cut.
    expect(build - royalty).toBe(bps(gross, 5400));
  });

  it("leaves the parent nothing when the fee is too small to carve a royalty from", () => {
    for (const gross of [0n, 1n, 16n]) {
      expect(bps(bps(gross, FEE_SPLIT_BPS.BUILD_BUDGET), FORK_ROYALTY_BPS)).toBe(0n);
    }
    // First amount whose build cut reaches 10 micros, the point where the parent earns its first micro.
    expect(bps(bps(17n, FEE_SPLIT_BPS.BUILD_BUDGET), FORK_ROYALTY_BPS)).toBe(1n);
    expect(bps(bps(16_667n, FEE_SPLIT_BPS.BUILD_BUDGET), FORK_ROYALTY_BPS)).toBe(1_000n);
  });
});

describe("usdMicrosFromWei", () => {
  it("prices a whole ETH at the quoted price", () => {
    expect(usdMicrosFromWei(WEI_PER_ETH, 2703.89)).toBe(2_703_890_000n);
    expect(usdMicrosFromWei(WEI_PER_ETH, 2000)).toBe(2_000_000_000n);
    expect(usdMicrosFromWei(0n, 2703.89)).toBe(0n);
  });

  it("prices the launch stake and fee at a few dollars, as designed", () => {
    // 0.002 ETH at $2,703.89 = $5.40778 → 5_407_780 micros.
    expect(usdMicrosFromWei(LAUNCH_STAKE_WEI, 2703.89)).toBe(5_407_780n);
    // 0.0005 ETH launch fee = $1.351945 → floored to the micro.
    expect(usdMicrosFromWei(PONS_LAUNCH_FEE_WEI, 2703.89)).toBe(1_351_945n);
  });

  it("floors sub-micro dust instead of inventing value", () => {
    // 1 wei at $2,703.89 is 2.7e-15 micro-dollars; charging a whole micro would mint money.
    expect(usdMicrosFromWei(1n, 2703.89)).toBe(0n);
    // 1 wei is 2.7e-15 micros; 0.37 gwei is the first amount worth a whole micro at that price.
    expect(usdMicrosFromWei(369_000_000n, 2703.89)).toBe(0n);
    expect(usdMicrosFromWei(370_000_000n, 2703.89)).toBe(1n);
  });

  it("rounds the price to micro-dollars before multiplying", () => {
    // $2,703.8900004 and $2,703.89 are the same micro-dollar price; sub-micro price noise never leaks.
    expect(usdMicrosFromWei(WEI_PER_ETH, 2703.8900004)).toBe(2_703_890_000n);
    expect(usdMicrosFromWei(WEI_PER_ETH, 2703.8900006)).toBe(2_703_890_001n);
  });

  it("stays exact for a whale-sized sweep where float math drifts", () => {
    const wei = 987_654_321_987_654_321_987_654_321n; // ~987M ETH
    expect(usdMicrosFromWei(wei, 2703.89)).toBe((wei * 2_703_890_000n) / WEI_PER_ETH);
    expect(Number(usdMicrosFromWei(wei, 2703.89))).not.toBe(Math.round((Number(wei) / 1e18) * 2703.89 * 1e6));
  });

  it("is zero at a zero price rather than NaN, since sweeps can run before the oracle warms up", () => {
    expect(usdMicrosFromWei(WEI_PER_ETH, 0)).toBe(0n);
  });

  it("rejects prices no oracle could have produced", () => {
    expect(() => usdMicrosFromWei(WEI_PER_ETH, Number.NaN)).toThrow(RangeError);
    expect(() => usdMicrosFromWei(WEI_PER_ETH, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => usdMicrosFromWei(WEI_PER_ETH, -1)).toThrow(RangeError);
  });
});

describe("weiFromUsdMicros", () => {
  it("buys exactly one ETH with one ETH's worth of dollars", () => {
    expect(weiFromUsdMicros(2_703_890_000n, 2703.89)).toBe(WEI_PER_ETH);
    expect(weiFromUsdMicros(1_000_000n, 2000)).toBe(500_000_000_000_000n); // $1 = 0.0005 ETH at $2,000
    expect(weiFromUsdMicros(0n, 2703.89)).toBe(0n);
  });

  it("floors so a buyback never overspends its USD allocation", () => {
    // $5 at $2,703.89 = 0.00184919... ETH; the last wei is dropped, never rounded up.
    const wei = weiFromUsdMicros(5_000_000n, 2703.89);
    expect(wei).toBe((5_000_000n * WEI_PER_ETH) / 2_703_890_000n);
    expect(usdMicrosFromWei(wei, 2703.89)).toBeLessThanOrEqual(5_000_000n);
    expect(usdMicrosFromWei(wei + 1n, 2703.89)).toBeGreaterThanOrEqual(5_000_000n);
  });

  it("round-trips through usdMicrosFromWei within one micro-dollar of ETH", () => {
    const price = 2703.89;
    const microInWei = WEI_PER_ETH / BigInt(Math.round(price));
    for (const wei of randomAmounts(300, 0x77e1)) {
      const back = weiFromUsdMicros(usdMicrosFromWei(wei, price), price);
      expect(back).toBeLessThanOrEqual(wei);
      expect(wei - back).toBeLessThanOrEqual(microInWei + 1n);
    }
  });

  it("refuses to divide by a zero price", () => {
    expect(() => weiFromUsdMicros(1_000_000n, 0)).toThrow(RangeError);
  });
});

describe("splitFees on a real sweep", () => {
  it("turns a 0.1 ETH claim into the exact 60/25/15 USD ledger rows", () => {
    const usdMicros = usdMicrosFromWei(100_000_000_000_000_000n, 2703.89); // $270.389
    expect(usdMicros).toBe(270_389_000n);
    const s = splitFees(usdMicros, false, false);
    expect(s.buildMicros + s.creditsMicros).toBe(162_233_400n); // 60%
    expect(s.pyreMicros).toBe(67_597_250n); // 25%
    expect(s.launcherMicros).toBe(40_558_350n); // 15%
    expect(s.buildMicros + s.creditsMicros + s.pyreMicros + s.launcherMicros + s.upstreamMicros + s.stakersMicros).toBe(usdMicros);
  });
});

describe("PONS v2 launch constants", () => {
  it("describe the fixed 1B supply with 18 decimals", () => {
    expect(TOKEN_DECIMALS).toBe(18);
    expect(PONS_TOTAL_SUPPLY).toBe(1_000_000_000_000_000_000_000_000_000n);
    // A 2% wallet cap on that supply is 20M tokens; regressing the cap to a percentage would 100x it.
    expect((PONS_TOTAL_SUPPLY * BigInt(VOTE_WALLET_CAP_BPS)) / 10_000n).toBe(20_000_000n * 10n ** 18n);
    // The ≥3% platform-governance submission gate on the same supply is 30M tokens in base units.
    expect((PONS_TOTAL_SUPPLY * BigInt(PLATFORM_PROPOSAL_MIN_HOLD_BPS)) / 10_000n).toBe(30_000_000n * 10n ** 18n);
  });

  it("orders the ETH thresholds the way the launch flow relies on", () => {
    // The stake must cover the PONS launch fee the treasury fronts, and both are dust next to graduation.
    expect(PONS_LAUNCH_FEE_WEI).toBe(500_000_000_000_000n);
    expect(LAUNCH_STAKE_WEI).toBe(2_000_000_000_000_000n);
    expect(LAUNCH_STAKE_WEI).toBeGreaterThan(PONS_LAUNCH_FEE_WEI);
    expect(PONS_GRADUATION_THRESHOLD_WEI).toBe(4_200_000_000_000_000_000n);
    expect(PONS_GRADUATION_THRESHOLD_WEI).toBeGreaterThan(LAUNCH_STAKE_WEI * 1000n);
  });
});
