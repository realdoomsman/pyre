import { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda } from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { MintLayout, unpackAccount } from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import type { PoolReserves, PumpState } from "../read.js";
import raw from "./mainnet-accounts.json" with { type: "json" };

/**
 * Real mainnet accounts captured on 2026-09-22 (`capturedAt` / `slot` in the JSON): pump Global +
 * FeeConfig, PumpSwap GlobalConfig + FeeConfig, one live bonding curve
 * (24rmto6q…pump, mid-curve, non-mayhem) and one graduated canonical pool (6SHba4Ej…, base mint
 * 5qpHoug4…pump) with its two vault token accounts. Tests decode them with the SDKs and run the
 * pure state → venue mappings offline.
 */
type Captured = { address: string; owner: string; lamports: number; data: string };
const accounts = raw.accounts as Record<string, Captured>;

export function accountInfo(name: string): AccountInfo<Buffer> & { address: PublicKey } {
  const a = accounts[name];
  if (!a) throw new Error(`no fixture account ${name}`);
  return { address: new PublicKey(a.address), owner: new PublicKey(a.owner), lamports: a.lamports, executable: false, data: Buffer.from(a.data, "base64") };
}

const shared = () => ({
  global: PUMP_SDK.decodeGlobal(accountInfo("global")),
  feeConfig: PUMP_SDK.decodeFeeConfig(accountInfo("feeConfig")),
  ammGlobalConfig: PUMP_AMM_SDK.decodeGlobalConfig(accountInfo("ammGlobalConfig")),
  ammFeeConfig: PUMP_AMM_SDK.decodeFeeConfig(accountInfo("ammFeeConfig")),
});

/** State of the mid-curve coin. */
export function curveState(): PumpState {
  const mintInfo = accountInfo("curveMint");
  const curveInfo = accountInfo("curve");
  const rawMint = MintLayout.decode(mintInfo.data);
  return {
    ...shared(),
    mint: mintInfo.address,
    curve: bondingCurvePda(mintInfo.address),
    pool: canonicalPumpPoolPda(mintInfo.address),
    bondingCurve: PUMP_SDK.decodeBondingCurve(curveInfo),
    bondingCurveAccountInfo: curveInfo,
    poolState: null,
    poolAccountInfo: null,
    tokenProgram: mintInfo.owner,
    rawMint,
    supply: rawMint.supply,
  };
}

/** State of the graduated coin plus its pool reserves. */
export function poolState(): { state: PumpState; reserves: PoolReserves } {
  const mintInfo = accountInfo("poolMint");
  const poolInfo = accountInfo("pool");
  const rawMint = MintLayout.decode(mintInfo.data);
  const pool = PUMP_AMM_SDK.decodePool(poolInfo);
  const curve = PUMP_SDK.decodeBondingCurve(accountInfo("curve"));
  const base = accountInfo("poolBaseAccount");
  const quote = accountInfo("poolQuoteAccount");
  return {
    state: {
      ...shared(),
      mint: mintInfo.address,
      curve: bondingCurvePda(mintInfo.address),
      pool: poolInfo.address,
      // The graduated coin's own curve was not captured; a completed copy of the live curve stands in.
      bondingCurve: { ...curve, complete: true },
      bondingCurveAccountInfo: null,
      poolState: pool,
      poolAccountInfo: poolInfo,
      tokenProgram: mintInfo.owner,
      rawMint,
      supply: rawMint.supply,
    },
    reserves: { base: unpackAccount(base.address, base, base.owner).amount, quote: unpackAccount(quote.address, quote, quote.owner).amount },
  };
}
