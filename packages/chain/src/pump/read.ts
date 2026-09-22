import { GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, type BondingCurve, type FeeConfig, type Global } from "@pump-fun/pump-sdk";
import { GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, PUMP_AMM_SDK, type FeeConfig as AmmFeeConfig, type GlobalConfig, type Pool } from "@pump-fun/pump-swap-sdk";
import { MintLayout, unpackAccount, type RawMint } from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import BN from "bn.js";
import { SOLANA_COMMITMENT, connection } from "../solana/connection.js";
import { pubkey } from "../solana/keys.js";
import type { VenueLaunchState, VenuePhase } from "../venue.js";

/** pump coins: 6 decimals, 1B supply, all minted at create. */
export const PUMP_TOKEN_DECIMALS = 6;
export const PUMP_TOTAL_SUPPLY_UNITS = 1_000_000_000_000_000n;

export const bn = (x: BN): bigint => BigInt(x.toString(10));
export const toBN = (x: bigint): BN => new BN(x.toString(10));

/** SOL per whole token from base-unit reserves (lamports per 1e6-unit token). */
export const priceFromReserves = (quoteLamports: bigint, tokenUnits: bigint): number => (tokenUnits > 0n ? (Number(quoteLamports) / Number(tokenUnits)) * 10 ** (PUMP_TOKEN_DECIMALS - 9) : 0);

/**
 * Lamports the curve holds when it completes, derived from the Global initial reserves the way the
 * program fills it: x·y = k on the virtual reserves until `initialRealTokenReserves` are sold.
 * Mainnet ≈ 85 SOL, devnet (1 SOL virtual) ≈ 2.83 SOL.
 */
export function graduationLamports(global: Pick<Global, "initialVirtualSolReserves" | "initialVirtualTokenReserves" | "initialRealTokenReserves">): bigint {
  const vSol = bn(global.initialVirtualSolReserves);
  const vTok = bn(global.initialVirtualTokenReserves);
  const rTok = bn(global.initialRealTokenReserves);
  if (vTok <= rTok) return 0n;
  return (vSol * vTok) / (vTok - rTok) - vSol;
}

/** Everything one round trip tells us about a pump coin. `bondingCurve` is null for a mint pump never launched. */
export interface PumpState {
  mint: PublicKey;
  curve: PublicKey;
  pool: PublicKey;
  global: Global;
  feeConfig: FeeConfig | null;
  ammGlobalConfig: GlobalConfig | null;
  ammFeeConfig: AmmFeeConfig | null;
  bondingCurve: BondingCurve | null;
  bondingCurveAccountInfo: AccountInfo<Buffer> | null;
  poolState: Pool | null;
  poolAccountInfo: AccountInfo<Buffer> | null;
  /** Owner program of the mint (Token-2022 for create_v2 coins); null when the mint does not exist. */
  tokenProgram: PublicKey | null;
  /** Raw SPL mint (supply, decimals); null when the mint does not exist. */
  rawMint: RawMint | null;
  /** Live mint supply in base units; burns reduce it. Null when the mint does not exist. */
  supply: bigint | null;
}

export async function readPumpState(mint: string): Promise<PumpState> {
  const mintKey = pubkey(mint);
  const curve = bondingCurvePda(mintKey);
  const pool = canonicalPumpPoolPda(mintKey);
  const [globalInfo, feeConfigInfo, ammGlobalInfo, ammFeeInfo, curveInfo, poolInfo, mintInfo] = await connection().getMultipleAccountsInfo(
    [GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, curve, pool, mintKey],
    SOLANA_COMMITMENT,
  );
  if (!globalInfo) throw new Error("pump Global account not found: wrong cluster?");
  const rawMint = mintInfo ? MintLayout.decode(mintInfo.data) : null;
  return {
    mint: mintKey,
    curve,
    pool,
    global: PUMP_SDK.decodeGlobal(globalInfo),
    feeConfig: feeConfigInfo ? PUMP_SDK.decodeFeeConfig(feeConfigInfo) : null,
    ammGlobalConfig: ammGlobalInfo ? PUMP_AMM_SDK.decodeGlobalConfig(ammGlobalInfo) : null,
    ammFeeConfig: ammFeeInfo ? PUMP_AMM_SDK.decodeFeeConfig(ammFeeInfo) : null,
    bondingCurve: curveInfo ? PUMP_SDK.decodeBondingCurveNullable(curveInfo) : null,
    bondingCurveAccountInfo: curveInfo ?? null,
    poolState: poolInfo ? PUMP_AMM_SDK.decodePoolNullable(poolInfo) : null,
    poolAccountInfo: poolInfo ?? null,
    tokenProgram: mintInfo?.owner ?? null,
    rawMint,
    supply: rawMint ? rawMint.supply : null,
  };
}

export interface PoolReserves {
  base: bigint;
  quote: bigint;
}

/** Token balances of the canonical pool's two vaults. */
export async function readPoolReserves(pool: Pool): Promise<PoolReserves> {
  const [baseInfo, quoteInfo] = await connection().getMultipleAccountsInfo([pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount], SOLANA_COMMITMENT);
  const base = baseInfo ? unpackAccount(pool.poolBaseTokenAccount, baseInfo, baseInfo.owner).amount : 0n;
  const quote = quoteInfo ? unpackAccount(pool.poolQuoteTokenAccount, quoteInfo, quoteInfo.owner).amount : 0n;
  return { base, quote };
}

/** Mirror of PONS phases: 0 on the curve, 1 complete but not yet migrated, 2 trading on the canonical PumpSwap pool. */
export function pumpPhase(state: Pick<PumpState, "bondingCurve" | "poolState">): VenuePhase {
  if (!state.bondingCurve || !state.bondingCurve.complete) return 0;
  return state.poolState ? 2 : 1;
}

/** Pure mapping to the venue shape; `reserves` are needed only in phase 2. Exported for tests. */
export function launchStateFrom(state: PumpState, reserves: PoolReserves | null): VenueLaunchState {
  const { bondingCurve, global, poolState } = state;
  const phase = pumpPhase(state);
  // The curve records the supply it was created with (1B; mayhem coins mint more), so burns are measured against it.
  const totalSupplyUnits = bn(bondingCurve?.tokenTotalSupply ?? global.tokenTotalSupply);
  const supply = state.supply ?? totalSupplyUnits;
  const graduationNative = graduationLamports(global);
  const initialReal = bn(global.initialRealTokenReserves);
  let progress = 1;
  let raisedNative = 0n;
  let priceNative = 0;
  if (bondingCurve) {
    raisedNative = bn(bondingCurve.realQuoteReserves);
    if (phase === 0) progress = initialReal > 0n ? Math.min(1, Math.max(0, 1 - Number(bn(bondingCurve.realTokenReserves)) / Number(initialReal))) : 0;
    priceNative = priceFromReserves(bn(bondingCurve.virtualQuoteReserves), bn(bondingCurve.virtualTokenReserves));
  }
  if (phase === 2 && poolState && reserves) {
    priceNative = priceFromReserves(reserves.quote + bn(poolState.virtualQuoteReserves), reserves.base);
  }
  return {
    exists: bondingCurve !== null,
    token: state.mint.toBase58(),
    curve: state.curve.toBase58(),
    pool: phase === 2 ? state.pool.toBase58() : null,
    phase,
    progress,
    raisedNative,
    graduationNative,
    priceNative,
    totalSupplyUnits,
    circulatingUnits: supply,
    burnedUnits: totalSupplyUnits > supply ? totalSupplyUnits - supply : 0n,
  };
}

export async function readPumpLaunch(mint: string): Promise<VenueLaunchState> {
  const state = await readPumpState(mint);
  const reserves = pumpPhase(state) === 2 && state.poolState ? await readPoolReserves(state.poolState) : null;
  return launchStateFrom(state, reserves);
}
