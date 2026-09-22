import {
  CREDITS_FUNDING_BPS,
  FEE_SPLIT_BPS,
  FORK_ROYALTY_BPS,
  ITERATION_BUDGET_USD,
  STAKERS_OF_LAUNCHER_BPS,
  WEI_PER_ETH,
  bps,
  formatUsdMicros,
  splitFees,
  usdMicrosFromWei,
  weiFromUsdMicros,
} from "@pyre/shared";
import { attestationHash } from "@pyre/chain";
import { describe, expect, it } from "vitest";

/**
 * Fee-sweep accounting: the single most consequential calculation in Pyre. Every escrow claim
 * is converted from wei to USD micros and split into the build budget, the $PYRE cut, the
 * launcher cut, an optional fork royalty and an optional staker share. The parts must always
 * sum back to the whole — a lost micro here is money that exists in no account.
 */

/** Deterministic PRNG: reproducible property checks over realistic sweep sizes. */
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

const ETH_PRICE = 4_187.42;

describe("usdMicrosFromWei at the sweep's boundary", () => {
  it("prices a whole ETH at the quoted price and floors sub-micro dust", () => {
    expect(usdMicrosFromWei(WEI_PER_ETH, 4000)).toBe(4_000_000_000n);
    expect(usdMicrosFromWei(WEI_PER_ETH, ETH_PRICE)).toBe(4_187_420_000n);
    expect(usdMicrosFromWei(0n, ETH_PRICE)).toBe(0n);
    // 1 wei at $4000 is 4e-12 micro-dollars; charging a whole micro would mint money.
    expect(usdMicrosFromWei(1n, 4000)).toBe(0n);
  });

  it("round-trips through weiFromUsdMicros within one micro-dollar of ETH", () => {
    const rand = mulberry32(0x1234);
    for (let i = 0; i < 200; i++) {
      const wei = BigInt(Math.floor(rand() * 1e15)) * 1_000n + 1_000_000_000_000n;
      const micros = usdMicrosFromWei(wei, ETH_PRICE);
      const back = weiFromUsdMicros(micros, ETH_PRICE);
      const drift = back > wei ? back - wei : wei - back;
      expect(drift).toBeLessThanOrEqual(WEI_PER_ETH / BigInt(Math.round(ETH_PRICE * 1e6)) + 1n);
    }
  });

  it("formats micros as dollars for ledger memos", () => {
    expect(formatUsdMicros(0n)).toBe("$0.00");
    expect(formatUsdMicros(1_234_567n)).toBe("$1.23");
    expect(formatUsdMicros(4_213_550_000n)).toBe("$4213.55");
  });
});

describe("splitFees conserves value", () => {
  const cases: Array<{ hasParent: boolean; hasStakers: boolean }> = [
    { hasParent: false, hasStakers: false },
    { hasParent: true, hasStakers: false },
    { hasParent: false, hasStakers: true },
    { hasParent: true, hasStakers: true },
  ];

  it("sums every part back to the gross fee for every combination", () => {
    const rand = mulberry32(0xfee5);
    const amounts = [0n, 1n, 2n, 3n, 7n, 9_999n, 10_000n, 10_001n, 1_000_000n, 4_213_550_000n];
    for (let i = 0; i < 300; i++) amounts.push(BigInt(Math.floor(rand() * 1e15)) + BigInt(Math.floor(rand() * 9_973)));
    for (const usdMicros of amounts) {
      for (const { hasParent, hasStakers } of cases) {
        const s = splitFees(usdMicros, hasParent, hasStakers);
        expect(s.usdMicros).toBe(usdMicros);
        expect(s.buildMicros + s.creditsMicros + s.pyreMicros + s.launcherMicros + s.upstreamMicros + s.stakersMicros).toBe(usdMicros);
        for (const part of [s.buildMicros, s.creditsMicros, s.pyreMicros, s.launcherMicros, s.upstreamMicros, s.stakersMicros]) {
          expect(part).toBeGreaterThanOrEqual(0n);
        }
      }
    }
  });

  it("matches the published 60/25/15 split for a clean $1,000 fee", () => {
    const s = splitFees(1_000_000_000n, false, false);
    expect(s).toEqual({
      usdMicros: 1_000_000_000n,
      buildMicros: 300_000_000n, // 30% spendable build budget (half the 60% build cut)
      creditsMicros: 300_000_000n, // 30% routed to the model-credit funding wallet
      pyreMicros: 250_000_000n, // 25% $PYRE
      launcherMicros: 150_000_000n, // 15% launcher
      upstreamMicros: 0n,
      stakersMicros: 0n,
    });
    expect(s.buildMicros + s.creditsMicros).toBe(bps(s.usdMicros, FEE_SPLIT_BPS.BUILD_BUDGET));
    expect(s.creditsMicros).toBe(bps(bps(s.usdMicros, FEE_SPLIT_BPS.BUILD_BUDGET), CREDITS_FUNDING_BPS));
    expect(s.pyreMicros).toBe(bps(s.usdMicros, FEE_SPLIT_BPS.PYRE_TOKEN));
    expect(s.launcherMicros).toBe(bps(s.usdMicros, FEE_SPLIT_BPS.LAUNCHER));
  });

  it("gives the launcher cut the rounding remainder, never the build budget", () => {
    const s = splitFees(10_001n, false, false);
    expect(s.buildMicros).toBe(3_000n);
    expect(s.creditsMicros).toBe(3_000n);
    expect(s.pyreMicros).toBe(2_500n);
    expect(s.launcherMicros).toBe(1_501n);
    expect(s.buildMicros + s.creditsMicros + s.pyreMicros + s.launcherMicros).toBe(10_001n);
  });

  it("assigns every micro of a dust fee, with royalty and staker cuts rounding to nothing", () => {
    expect(splitFees(1n, true, true)).toEqual({ usdMicros: 1n, buildMicros: 0n, creditsMicros: 0n, pyreMicros: 0n, launcherMicros: 1n, upstreamMicros: 0n, stakersMicros: 0n });
    expect(splitFees(2n, true, true)).toEqual({ usdMicros: 2n, buildMicros: 1n, creditsMicros: 0n, pyreMicros: 0n, launcherMicros: 1n, upstreamMicros: 0n, stakersMicros: 0n });
    expect(splitFees(3n, true, true)).toEqual({ usdMicros: 3n, buildMicros: 1n, creditsMicros: 0n, pyreMicros: 0n, launcherMicros: 2n, upstreamMicros: 0n, stakersMicros: 0n });
  });
});

describe("fork royalty routing", () => {
  it("routes exactly FORK_ROYALTY_BPS of the build cut upstream", () => {
    const gross = 1_000_000_000n;
    const fork = splitFees(gross, true, false);
    const solo = splitFees(gross, false, false);
    expect(fork.upstreamMicros).toBe(bps(bps(gross, FEE_SPLIT_BPS.BUILD_BUDGET), FORK_ROYALTY_BPS));
    expect(fork.upstreamMicros).toBe(60_000_000n);
    expect(fork.buildMicros + fork.creditsMicros).toBe(bps(gross, FEE_SPLIT_BPS.BUILD_BUDGET) - fork.upstreamMicros);
    expect(fork.pyreMicros).toBe(solo.pyreMicros);
    expect(fork.launcherMicros).toBe(solo.launcherMicros);
  });

  it("never charges a royalty when the app has no parent", () => {
    for (const gross of [0n, 1n, 10_000n, 1_000_000_000n]) {
      expect(splitFees(gross, false, false).upstreamMicros).toBe(0n);
      expect(splitFees(gross, false, true).upstreamMicros).toBe(0n);
    }
  });

  it("is applied once, so a fork of a fork does not double-charge one fee", () => {
    const gross = 1_000_000_000n;
    const child = splitFees(gross, true, false);
    expect(child.upstreamMicros).toBe(60_000_000n);
    expect(child.buildMicros + child.creditsMicros + child.pyreMicros + child.launcherMicros + child.upstreamMicros).toBe(gross);
  });

  it("keeps the royalty proportional to the wei the way recordCreatorFee derives it", () => {
    // recordCreatorFee computes royaltyWei = wei * upstreamMicros / usdMicros.
    const wei = 25n * WEI_PER_ETH / 10n; // 2.5 ETH
    const usdMicros = usdMicrosFromWei(wei, ETH_PRICE);
    const split = splitFees(usdMicros, true, false);
    const royaltyWei = (wei * split.upstreamMicros) / usdMicros;
    expect(royaltyWei).toBeGreaterThan(0n);
    expect(royaltyWei).toBeLessThan(wei / 10n);
    // 6% of gross in wei terms, within rounding of a micro-dollar.
    const expectedWei = (wei * 600n) / 10_000n;
    const drift = royaltyWei > expectedWei ? royaltyWei - expectedWei : expectedWei - royaltyWei;
    expect(drift).toBeLessThanOrEqual(WEI_PER_ETH / BigInt(Math.round(ETH_PRICE * 1e6)) + 1n);
  });
});

describe("staker share of the launcher cut", () => {
  it("takes STAKERS_OF_LAUNCHER_BPS out of the launcher cut only", () => {
    const gross = 1_000_000_000n;
    const staked = splitFees(gross, false, true);
    const solo = splitFees(gross, false, false);
    expect(staked.stakersMicros).toBe(bps(solo.launcherMicros, STAKERS_OF_LAUNCHER_BPS));
    expect(staked.stakersMicros).toBe(30_000_000n);
    expect(staked.launcherMicros).toBe(solo.launcherMicros - staked.stakersMicros);
    expect(staked.buildMicros).toBe(solo.buildMicros);
    expect(staked.pyreMicros).toBe(solo.pyreMicros);
  });

  it("stacks with a fork royalty without either cut paying twice", () => {
    expect(splitFees(1_000_000_000n, true, true)).toEqual({
      usdMicros: 1_000_000_000n,
      buildMicros: 270_000_000n,
      creditsMicros: 270_000_000n,
      pyreMicros: 250_000_000n,
      launcherMicros: 120_000_000n,
      upstreamMicros: 60_000_000n,
      stakersMicros: 30_000_000n,
    });
  });
});

describe("FeeEvent field set", () => {
  it("conserves the gross value across the fields written to the row", () => {
    const wei = 1_337n * WEI_PER_ETH / 1_000n;
    const usdMicros = usdMicrosFromWei(wei, ETH_PRICE);
    const s = splitFees(usdMicros, true, true);
    expect(s.buildMicros + s.creditsMicros + s.pyreMicros + s.launcherMicros + s.upstreamMicros + s.stakersMicros).toBe(usdMicros);
  });

  it("needs ~$33.33 of creator fees to revive a dormant app, since credits halve the spendable build cut", () => {
    const minIterMicros = BigInt(ITERATION_BUDGET_USD.MIN) * 1_000_000n;
    expect(splitFees(33_333_330n, false, false).buildMicros).toBe(minIterMicros - 1n);
    expect(splitFees(33_333_334n, false, false).buildMicros).toBe(minIterMicros);
  });
});

describe("burn attestation hash", () => {
  const ids = ["led_c", "led_a", "led_b"];

  it("is order independent and does not mutate the caller's array", () => {
    const sorted = attestationHash(["led_a", "led_b", "led_c"]);
    expect(attestationHash(ids)).toBe(sorted);
    expect(attestationHash([...ids].reverse())).toBe(sorted);
    const input = [...ids];
    attestationHash(input);
    expect(input).toEqual(ids);
  });

  it("changes when the event set changes, including a duplicate id", () => {
    const base = attestationHash(ids);
    expect(attestationHash([...ids, "led_d"])).not.toBe(base);
    expect(attestationHash(["led_a", "led_b"])).not.toBe(base);
    expect(attestationHash([...ids, "led_a"])).not.toBe(base);
  });

  it("is a pinned 0x sha256 of the comma-joined sorted ids", () => {
    // Anyone auditing a $PYRE burn recomputes this from the PYRE_TOKEN ledger credit ids and the
    // attestation calldata (0x5059524501 || hash), so the recipe must not drift.
    expect(attestationHash(["rev_c", "rev_a", "rev_b"])).toBe("0x78e9b6e5df154dc1d9d8820d76252ceeae39628b5011226b55e8dd76f8544723");
    expect(attestationHash([])).toBe("0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("fee share feeding the $PYRE buyback", () => {
  it("converts the accrued PYRE_TOKEN balance to wei at the quoted ETH price", () => {
    const pendingMicros = 3_581_517_500n;
    const wei = weiFromUsdMicros(pendingMicros, ETH_PRICE);
    expect(wei).toBe((pendingMicros * WEI_PER_ETH) / BigInt(Math.round(ETH_PRICE * 1e6)));
    // Sanity: $3,581 of ETH at $4,187.42 is ~0.855 ETH.
    expect(Number(wei) / 1e18).toBeCloseTo(0.855, 2);
  });
});
