import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK, computeFeesBps as curveFeesBps, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput, computeFeesBps as ammFeesBps, sellBaseInput, type Pool } from "@pump-fun/pump-swap-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TransactionInstruction, type Keypair, type PublicKey } from "@solana/web3.js";
import { SOLANA_COMMITMENT, connection } from "../solana/connection.js";
import { COMPUTE_UNITS } from "../solana/fees.js";
import { pubkey } from "../solana/keys.js";
import { sendInstructions, type SolanaTxResult } from "../solana/send.js";
import type { VenueBuyResult, VenueQuote, VenueSellResult } from "../venue.js";
import { decodePumpEvents } from "./events.js";
import { bn, priceFromReserves, pumpPhase, readPoolReserves, readPumpState, toBN, type PoolReserves, type PumpState } from "./read.js";
import { fillFromEvent, type PumpFill } from "./trades.js";

/**
 * Custodial trading on both pump phases. Buys are exact-in (`buy_exact_sol_in` on the curve,
 * `buy_exact_quote_in` on PumpSwap) so `spendNative` is what leaves the wallet and
 * `minTokenUnits` is the slippage floor; sells are exact-in by construction. The SDKs only build
 * the exact-out `buy`, whose account list is identical to the exact-in variant, so the buy
 * instruction is built by the SDK and its data swapped for the exact-in discriminator + args.
 */
const CURVE_BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const CURVE_BUY_EXACT_SOL_IN = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]);
const AMM_BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const AMM_BUY_EXACT_QUOTE_IN = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);

export class PumpMigratingError extends Error {
  constructor(readonly mint: string) {
    super(`pump coin ${mint} completed its curve and is migrating to PumpSwap; trading resumes once the pool exists`);
    this.name = "PumpMigratingError";
  }
}

const u64 = (v: bigint): Buffer => {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 out of range: ${v}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

/**
 * Rewrites an exact-out buy built by the SDK into its exact-in twin: same accounts, new
 * discriminator, `(spendable, minOut)` in place of `(amountOut, maxIn)`, trailing args kept.
 * Pure; exported for tests.
 */
export function toExactIn(ix: TransactionInstruction, from: Buffer, to: Buffer, spendable: bigint, minOut: bigint): TransactionInstruction {
  if (!ix.data.subarray(0, 8).equals(from)) throw new Error("not the instruction to rewrite");
  const data = Buffer.concat([to, u64(spendable), u64(minOut), ix.data.subarray(24)]);
  return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
}

function rewriteBuy(ixs: TransactionInstruction[], program: PublicKey, from: Buffer, to: Buffer, spendable: bigint, minOut: bigint): TransactionInstruction[] {
  let rewritten = 0;
  const out = ixs.map((ix) => {
    if (!ix.programId.equals(program) || !ix.data.subarray(0, 8).equals(from)) return ix;
    rewritten++;
    return toExactIn(ix, from, to, spendable, minOut);
  });
  if (rewritten !== 1) throw new Error(`expected one buy instruction to rewrite, found ${rewritten}`);
  return out;
}

const impactOf = (execPrice: number, spot: number): number => (spot > 0 ? Math.abs(execPrice / spot - 1) : 0);

function requirePool(state: PumpState): Pool {
  if (!state.poolState) throw new PumpMigratingError(state.mint.toBase58());
  return state.poolState;
}

function requireCurve(state: PumpState): NonNullable<PumpState["bondingCurve"]> {
  if (!state.bondingCurve) throw new Error(`pump coin ${state.mint.toBase58()} does not exist`);
  return state.bondingCurve;
}

function ammQuoteInputs(state: PumpState, reserves: PoolReserves) {
  const pool = requirePool(state);
  if (!state.ammGlobalConfig || !state.rawMint) throw new Error("PumpSwap global config or mint missing");
  return {
    baseReserve: toBN(reserves.base),
    quoteReserve: toBN(reserves.quote),
    virtualQuoteReserves: pool.virtualQuoteReserves,
    globalConfig: state.ammGlobalConfig,
    baseMintAccount: state.rawMint,
    baseMint: pool.baseMint,
    coinCreator: pool.coinCreator,
    creator: pool.creator,
    feeConfig: state.ammFeeConfig,
    quoteMint: pool.quoteMint,
    isMayhemMode: pool.isMayhemMode,
    creatorFeeBps: pool.creatorFeeBps,
  };
}

function ammFeeBps(state: PumpState, reserves: PoolReserves): number {
  const pool = requirePool(state);
  if (!state.ammGlobalConfig || !state.rawMint) throw new Error("PumpSwap global config or mint missing");
  const fees = ammFeesBps({
    globalConfig: state.ammGlobalConfig,
    feeConfig: state.ammFeeConfig,
    creator: pool.creator,
    baseMintSupply: toBN(state.rawMint.supply),
    baseMint: pool.baseMint,
    baseReserve: toBN(reserves.base),
    quoteReserve: toBN(reserves.quote),
    quoteMint: pool.quoteMint,
    isMayhemMode: pool.isMayhemMode,
    creatorFeeBps: pool.creatorFeeBps,
  });
  return Number(bn(fees.lpFeeBps) + bn(fees.protocolFeeBps) + bn(fees.creatorFeeBps));
}

function curveFeeBps(state: PumpState): number {
  const curve = requireCurve(state);
  const fees = curveFeesBps({
    global: state.global,
    feeConfig: state.feeConfig,
    mintSupply: curve.tokenTotalSupply,
    virtualQuoteReserves: curve.virtualQuoteReserves,
    virtualTokenReserves: curve.virtualTokenReserves,
    quoteMint: curve.quoteMint,
    creatorFeeBps: curve.creatorFeeBps,
  });
  return Number(bn(fees.protocolFeeBps) + bn(fees.creatorFeeBps));
}

/** Pure quote from read state; `reserves` required in phase 2. Exported for tests. */
export function quoteBuyFrom(state: PumpState, reserves: PoolReserves | null, spendLamports: bigint): VenueQuote {
  if (spendLamports <= 0n) throw new Error("quoteBuy: spend must be positive");
  const phase = pumpPhase(state);
  if (phase === 1) throw new PumpMigratingError(state.mint.toBase58());
  if (phase === 2) {
    if (!reserves) throw new Error("pool reserves required");
    const pool = requirePool(state);
    const { base } = buyQuoteInput({ quote: toBN(spendLamports), slippage: 0, ...ammQuoteInputs(state, reserves) });
    const tokenUnits = bn(base);
    const spot = priceFromReserves(reserves.quote + bn(pool.virtualQuoteReserves), reserves.base);
    const priceNative = priceFromReserves(spendLamports, tokenUnits);
    return { native: spendLamports, tokenUnits, priceNative, feeBps: ammFeeBps(state, reserves), impact: impactOf(priceNative, spot) };
  }
  const curve = requireCurve(state);
  const tokens = getBuyTokenAmountFromSolAmount({ global: state.global, feeConfig: state.feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: toBN(spendLamports), quoteMint: curve.quoteMint });
  const tokenUnits = bn(tokens);
  const spot = priceFromReserves(bn(curve.virtualQuoteReserves), bn(curve.virtualTokenReserves));
  const priceNative = priceFromReserves(spendLamports, tokenUnits);
  return { native: spendLamports, tokenUnits, priceNative, feeBps: curveFeeBps(state), impact: impactOf(priceNative, spot) };
}

/** Pure sell quote (native received net of fees). Exported for tests. */
export function quoteSellFrom(state: PumpState, reserves: PoolReserves | null, tokenUnits: bigint): VenueQuote {
  if (tokenUnits <= 0n) throw new Error("quoteSell: tokenUnits must be positive");
  const phase = pumpPhase(state);
  if (phase === 1) throw new PumpMigratingError(state.mint.toBase58());
  if (phase === 2) {
    if (!reserves) throw new Error("pool reserves required");
    const pool = requirePool(state);
    const { uiQuote } = sellBaseInput({ base: toBN(tokenUnits), slippage: 0, ...ammQuoteInputs(state, reserves) });
    const native = bn(uiQuote);
    const spot = priceFromReserves(reserves.quote + bn(pool.virtualQuoteReserves), reserves.base);
    const priceNative = priceFromReserves(native, tokenUnits);
    return { native, tokenUnits, priceNative, feeBps: ammFeeBps(state, reserves), impact: impactOf(priceNative, spot) };
  }
  const curve = requireCurve(state);
  const out = getSellSolAmountFromTokenAmount({ global: state.global, feeConfig: state.feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: toBN(tokenUnits) });
  const native = bn(out);
  const spot = priceFromReserves(bn(curve.virtualQuoteReserves), bn(curve.virtualTokenReserves));
  const priceNative = priceFromReserves(native, tokenUnits);
  return { native, tokenUnits, priceNative, feeBps: curveFeeBps(state), impact: impactOf(priceNative, spot) };
}

async function stateWithReserves(mint: string): Promise<{ state: PumpState; reserves: PoolReserves | null }> {
  const state = await readPumpState(mint);
  const reserves = pumpPhase(state) === 2 && state.poolState ? await readPoolReserves(state.poolState) : null;
  return { state, reserves };
}

export async function pumpQuoteBuy(mint: string, spendLamports: bigint): Promise<VenueQuote> {
  const { state, reserves } = await stateWithReserves(mint);
  return quoteBuyFrom(state, reserves, spendLamports);
}

export async function pumpQuoteSell(mint: string, tokenUnits: bigint): Promise<VenueQuote> {
  const { state, reserves } = await stateWithReserves(mint);
  return quoteSellFrom(state, reserves, tokenUnits);
}

/** The fill this transaction produced for `user` on `mint`, from the launchpad's own event. */
function fillFrom(res: SolanaTxResult, state: PumpState, user: PublicKey, side: "buy" | "sell"): PumpFill {
  const wallet = user.toBase58();
  for (const ev of decodePumpEvents(res.tx)) {
    const fill = fillFromEvent(ev, state.mint, state.pool);
    if (fill && fill.side === side && fill.wallet === wallet) return fill;
  }
  throw new Error(`pump ${side} ${res.signature}: no fill event for ${wallet}`);
}

export async function pumpBuy(account: Keypair, mint: string, spendLamports: bigint, minTokenUnits: bigint): Promise<VenueBuyResult> {
  if (spendLamports <= 0n) throw new Error("pumpBuy: spend must be positive");
  const state = await readPumpState(mint);
  const phase = pumpPhase(state);
  if (phase === 1) throw new PumpMigratingError(mint);
  if (!state.tokenProgram) throw new Error(`pump mint ${mint} does not exist`);
  const user = account.publicKey;
  let ixs: TransactionInstruction[];
  let units: number;
  if (phase === 2) {
    const swapState = await new OnlinePumpAmmSdk(connection()).swapSolanaState(state.pool, user);
    const built = await PUMP_AMM_SDK.buyInstructions(swapState, toBN(minTokenUnits), toBN(spendLamports));
    ixs = rewriteBuy(built, PUMP_AMM_PROGRAM_ID, AMM_BUY, AMM_BUY_EXACT_QUOTE_IN, spendLamports, minTokenUnits);
    units = COMPUTE_UNITS.ammSwap;
  } else {
    const curve = requireCurve(state);
    const ata = getAssociatedTokenAddressSync(state.mint, user, true, state.tokenProgram);
    const associatedUserAccountInfo = await connection().getAccountInfo(ata, SOLANA_COMMITMENT);
    const built = await PUMP_SDK.buyInstructions({
      global: state.global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo!,
      bondingCurve: curve,
      associatedUserAccountInfo,
      mint: state.mint,
      user,
      amount: toBN(minTokenUnits),
      solAmount: toBN(spendLamports),
      slippage: 0,
      tokenProgram: state.tokenProgram,
    });
    ixs = rewriteBuy(built, PUMP_PROGRAM_ID, CURVE_BUY, CURVE_BUY_EXACT_SOL_IN, spendLamports, minTokenUnits);
    units = COMPUTE_UNITS.curveSwap;
  }
  const res = await sendInstructions(account, ixs, { computeUnits: units });
  const fill = fillFrom(res, state, user, "buy");
  return { hash: res.signature, block: res.slot, tokenUnits: fill.tokenUnits, spentNative: fill.quoteNative };
}

export async function pumpSell(account: Keypair, mint: string, tokenUnits: bigint, minLamports: bigint): Promise<VenueSellResult> {
  if (tokenUnits <= 0n) throw new Error("pumpSell: tokenUnits must be positive");
  const state = await readPumpState(mint);
  const phase = pumpPhase(state);
  if (phase === 1) throw new PumpMigratingError(mint);
  if (!state.tokenProgram) throw new Error(`pump mint ${mint} does not exist`);
  const user = account.publicKey;
  let ixs: TransactionInstruction[];
  let units: number;
  if (phase === 2) {
    const swapState = await new OnlinePumpAmmSdk(connection()).swapSolanaState(state.pool, user);
    ixs = await PUMP_AMM_SDK.sellInstructions(swapState, toBN(tokenUnits), toBN(minLamports));
    units = COMPUTE_UNITS.ammSwap;
  } else {
    const curve = requireCurve(state);
    ixs = await PUMP_SDK.sellInstructions({
      global: state.global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo!,
      bondingCurve: curve,
      mint: state.mint,
      user,
      amount: toBN(tokenUnits),
      solAmount: toBN(minLamports),
      slippage: 0,
      tokenProgram: state.tokenProgram,
      mayhemMode: curve.isMayhemMode,
      cashback: curve.isCashbackCoin,
    });
    units = COMPUTE_UNITS.curveSwap;
  }
  const res = await sendInstructions(account, ixs, { computeUnits: units });
  const fill = fillFrom(res, state, user, "sell");
  return { hash: res.signature, block: res.slot, receivedNative: fill.quoteNative };
}
