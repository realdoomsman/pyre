import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK } from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK, type SwapSolanaState } from "@pump-fun/pump-swap-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { curveState, poolState } from "./fixtures/mainnet.js";
import { bn, toBN } from "./read.js";
import { PumpMigratingError, quoteBuyFrom, quoteSellFrom, toExactIn } from "./swap.js";

const SOL = 1_000_000_000n;
const BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const BUY_EXACT_SOL_IN = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]);
const BUY_EXACT_QUOTE_IN = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);

/** x·y = k on the virtual reserves, fees taken off the input at 1.25% (95 protocol + 30 creator bps). */
function curveBuyTokens(vQuote: bigint, vToken: bigint, spend: bigint, totalFeeBps: bigint): bigint {
  const net = (spend * 10_000n) / (10_000n + totalFeeBps);
  return (vToken * net) / (vQuote + net);
}

describe("pump quotes on the curve", () => {
  const state = curveState();
  const curve = state.bondingCurve!;

  it("quotes a buy at the curve's x·y=k with pump's 1.25% taken off the spend", () => {
    const q = quoteBuyFrom(state, null, SOL);
    const expected = curveBuyTokens(bn(curve.virtualQuoteReserves), bn(curve.virtualTokenReserves), SOL, 125n);
    expect(q.feeBps).toBe(125);
    expect(q.native).toBe(SOL);
    expect(Number(q.tokenUnits) / Number(expected)).toBeCloseTo(1, 6);
    // Execution price is above spot by the slippage the fill causes, not by the fee alone.
    expect(q.impact).toBeGreaterThan(0.012);
    expect(q.impact).toBeLessThan(0.05);
    expect(q.priceNative).toBeCloseTo(Number(SOL) / Number(q.tokenUnits) / 1e3, 20);
  });

  it("quotes a sell net of fees off the output and round-trips below the buy", () => {
    const tokens = 10n ** 12n;
    const q = quoteSellFrom(state, null, tokens);
    const gross = (bn(curve.virtualQuoteReserves) * tokens) / (bn(curve.virtualTokenReserves) + tokens);
    const ceilBps = (x: bigint, bps: bigint): bigint => (x * bps + 9_999n) / 10_000n;
    expect(q.native).toBe(gross - ceilBps(gross, 95n) - ceilBps(gross, 30n));
    expect(q.feeBps).toBe(125);
    // Selling the tokens a 1 SOL buy yields back into the *same* (pre-buy) reserves loses the
    // fees twice plus the curve's own slippage, and nothing more.
    const buy = quoteBuyFrom(state, null, SOL);
    const back = quoteSellFrom(state, null, buy.tokenUnits);
    expect(back.native).toBeLessThan(SOL);
    expect(back.native).toBeGreaterThan((SOL * 90n) / 100n);
  });

  it("rejects non-positive sizes and a completed curve that has no pool yet", () => {
    expect(() => quoteBuyFrom(state, null, 0n)).toThrow();
    expect(() => quoteSellFrom(state, null, -1n)).toThrow();
    const migrating = { ...state, bondingCurve: { ...curve, complete: true } };
    expect(() => quoteBuyFrom(migrating, null, SOL)).toThrow(PumpMigratingError);
    expect(() => quoteSellFrom(migrating, null, 1n)).toThrow(PumpMigratingError);
  });
});

describe("pump quotes on the canonical pool", () => {
  const { state, reserves } = poolState();

  it("prices off the vaults plus virtual quote and takes the tier-0 fee for a small-cap pool", () => {
    const buy = quoteBuyFrom(state, reserves, SOL);
    expect(buy.feeBps).toBe(125); // 30 creator + 93 protocol + 2 lp below 420 SOL mcap
    expect(buy.native).toBe(SOL);
    const spot = (Number(reserves.quote + bn(state.poolState!.virtualQuoteReserves)) / Number(reserves.base)) * 1e-3;
    expect(buy.priceNative).toBeGreaterThan(spot);
    expect(buy.priceNative / spot - 1).toBeCloseTo(buy.impact, 12);
    const sell = quoteSellFrom(state, reserves, buy.tokenUnits);
    expect(sell.native).toBeLessThan(SOL);
    expect(sell.native).toBeGreaterThan((SOL * 85n) / 100n);
  });

  it("needs the reserves", () => {
    expect(() => quoteBuyFrom(state, null, SOL)).toThrow(/reserves/);
  });
});

describe("exact-in rewrite", () => {
  it("swaps the discriminator and the two u64 args, keeps accounts and trailing bytes", () => {
    const ix = new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys: [{ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true }], data: Buffer.concat([BUY, Buffer.alloc(16, 0xaa), Buffer.from([1, 1])]) });
    const out = toExactIn(ix, BUY, BUY_EXACT_SOL_IN, 123n, 45n);
    expect(out.keys).toBe(ix.keys);
    expect(out.data.subarray(0, 8)).toEqual(BUY_EXACT_SOL_IN);
    expect(out.data.readBigUInt64LE(8)).toBe(123n);
    expect(out.data.readBigUInt64LE(16)).toBe(45n);
    expect(out.data.subarray(24)).toEqual(Buffer.from([1, 1]));
    expect(() => toExactIn(ix, BUY_EXACT_SOL_IN, BUY, 1n, 1n)).toThrow();
    expect(() => toExactIn(ix, BUY, BUY_EXACT_SOL_IN, -1n, 1n)).toThrow();
  });

  it("finds exactly one curve buy in what the SDK builds, with the legacy discriminator", async () => {
    const state = curveState();
    const user = Keypair.generate().publicKey;
    const ixs = await PUMP_SDK.buyInstructions({
      global: state.global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo!,
      bondingCurve: state.bondingCurve!,
      associatedUserAccountInfo: null,
      mint: state.mint,
      user,
      amount: new BN(1),
      solAmount: toBN(SOL),
      slippage: 0,
      tokenProgram: state.tokenProgram!,
    });
    const buys = ixs.filter((ix) => ix.programId.equals(PUMP_PROGRAM_ID) && ix.data.subarray(0, 8).equals(BUY));
    expect(buys).toHaveLength(1);
    expect(buys[0]!.data.readBigUInt64LE(16)).toBe(SOL); // max_sol_cost = spend with slippage 0
    expect(buys[0]!.keys.length).toBeGreaterThanOrEqual(16);
  });

  it("finds exactly one PumpSwap buy in what the AMM SDK builds", async () => {
    const { state, reserves } = poolState();
    const pool = state.poolState!;
    const user = Keypair.generate().publicKey;
    const swapState: SwapSolanaState = {
      globalConfig: state.ammGlobalConfig!,
      feeConfig: state.ammFeeConfig,
      poolKey: state.pool,
      poolAccountInfo: state.poolAccountInfo,
      pool,
      poolBaseAmount: toBN(reserves.base),
      poolQuoteAmount: toBN(reserves.quote),
      baseTokenProgram: state.tokenProgram!,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      baseMint: pool.baseMint,
      baseMintAccount: state.rawMint!,
      user,
      userBaseTokenAccount: getAssociatedTokenAddressSync(pool.baseMint, user, true, state.tokenProgram!),
      userQuoteTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID),
      userBaseAccountInfo: null,
      userQuoteAccountInfo: null,
    };
    const ixs = await PUMP_AMM_SDK.buyInstructions(swapState, new BN(1), toBN(SOL));
    const buys = ixs.filter((ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID) && ix.data.subarray(0, 8).equals(BUY));
    expect(buys).toHaveLength(1);
    const exactIn = toExactIn(buys[0]!, BUY, BUY_EXACT_QUOTE_IN, SOL, 7n);
    expect(exactIn.data.subarray(0, 8)).toEqual(BUY_EXACT_QUOTE_IN);
    expect(exactIn.keys.map((k) => k.pubkey.toBase58())).toEqual(buys[0]!.keys.map((k) => k.pubkey.toBase58()));
  });
});
