import { describe, expect, it } from "vitest";
import { curveState, poolState } from "./fixtures/mainnet.js";
import { graduationLamports, launchStateFrom, priceFromReserves, pumpPhase } from "./read.js";

const SOL = 1_000_000_000n;

describe("pump launch state", () => {
  it("derives the mainnet graduation threshold from the Global initial reserves", () => {
    const { global } = curveState();
    // 30 SOL virtual × 1073M / (1073M − 793.1M) − 30 SOL ≈ 85.0 SOL raised at completion.
    expect(graduationLamports(global)).toBe(85_005_359_056n);
    // Devnet seeds 1 SOL of virtual quote: the same curve completes after ≈ 2.83 SOL.
    expect(graduationLamports({ ...global, initialVirtualSolReserves: global.initialVirtualSolReserves.divn(30) })).toBe(2_833_511_968n);
  });

  it("maps a live curve: phase 0, progress from tokens sold, spot from virtual reserves, burns from supply", () => {
    const state = curveState();
    const s = launchStateFrom(state, null);
    expect(s).toMatchObject({ exists: true, phase: 0, pool: null, token: "24rmto6q4X2vfYPxxYcmbhRA92przKHyXGt6Lbdfpump", raisedNative: 16_473_156_977n, totalSupplyUnits: 10n ** 15n });
    expect(s.progress).toBeCloseTo(1 - 412_757_923_206_523 / 793_100_000_000_000, 12);
    expect(s.priceNative).toBeCloseTo(priceFromReserves(46_473_156_977n, 692_657_923_206_523n), 20);
    expect(s.priceNative * 1e9).toBeCloseTo(67.09, 1); // market cap ≈ 67 SOL
    expect(s.burnedUnits).toBe(1n);
    expect(s.circulatingUnits).toBe(999_999_999_999_999n);
  });

  it("reports a completed curve without a pool as migrating (phase 1) and a pool as phase 2 priced off the pool", () => {
    const { state, reserves } = poolState();
    expect(pumpPhase({ bondingCurve: state.bondingCurve, poolState: null })).toBe(1);
    const migrating = launchStateFrom({ ...state, poolState: null }, null);
    expect(migrating).toMatchObject({ phase: 1, pool: null, progress: 1 });
    const s = launchStateFrom(state, reserves);
    expect(s).toMatchObject({ phase: 2, pool: "6SHba4EjRggfc2LKxLHS4xSicPyunYGHi8BM8JwSe5WW", progress: 1 });
    // Effective quote = vault WSOL + the pool's virtual quote, over the base vault.
    expect(s.priceNative).toBeCloseTo(priceFromReserves(2_996_490_766n + 17_584_505_290n, 926_890_927_740_527n), 20);
    expect(s.burnedUnits).toBe(10n ** 15n - 972_301_286_577_231n);
  });

  it("treats a mint pump never launched as non-existent", () => {
    const state = { ...curveState(), bondingCurve: null, bondingCurveAccountInfo: null, tokenProgram: null, rawMint: null, supply: null };
    expect(launchStateFrom(state, null)).toMatchObject({ exists: false, phase: 0, progress: 1, raisedNative: 0n, priceNative: 0, burnedUnits: 0n });
  });

  it("prices lamports per 1e6-unit token as SOL per whole token", () => {
    expect(priceFromReserves(SOL, 1_000_000n)).toBe(1); // 1 SOL for one whole token
    expect(priceFromReserves(30n * SOL, 1_073_000_000n * 1_000_000n)).toBeCloseTo(2.7959e-8, 12);
    expect(priceFromReserves(1n, 0n)).toBe(0);
  });
});
