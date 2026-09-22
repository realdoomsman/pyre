import { OnlinePumpSdk, creatorVaultPda } from "@pump-fun/pump-sdk";
import { coinCreatorVaultAtaPda, coinCreatorVaultAuthorityPda } from "@pump-fun/pump-swap-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { SOLANA_COMMITMENT, connection } from "../solana/connection.js";
import { COMPUTE_UNITS } from "../solana/fees.js";
import { pubkey } from "../solana/keys.js";
import { lamportDelta, sendInstructions } from "../solana/send.js";
import type { VenueFees } from "../venue.js";

/**
 * Creator fees on pump accrue per creator wallet, not per coin: curve fees as lamports in the pump
 * `creator-vault` PDA (claimable above its rent), pool fees as WSOL in the PumpSwap
 * `creator_vault` ATA. Each Pyre app has its own wallet, so "the app's fees" and "the creator's
 * fees" are the same thing. Nothing needs sweeping: trades pay the vaults directly.
 */
export interface CreatorVaultBalances {
  curve: bigint;
  amm: bigint;
}

let rentExemptZero: Promise<bigint> | undefined;

export async function creatorVaultBalances(creator: PublicKey): Promise<CreatorVaultBalances> {
  const conn = connection();
  const vault = creatorVaultPda(creator);
  const ammVaultAta = coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(creator), NATIVE_MINT, TOKEN_PROGRAM_ID);
  rentExemptZero ??= conn.getMinimumBalanceForRentExemption(0).then(BigInt);
  const [[vaultInfo, ataInfo], rent] = await Promise.all([conn.getMultipleAccountsInfo([vault, ammVaultAta], SOLANA_COMMITMENT), rentExemptZero]);
  const lamports = vaultInfo ? BigInt(vaultInfo.lamports) : 0n;
  const curve = lamports > rent ? lamports - rent : 0n;
  const amm = ataInfo && ataInfo.owner.equals(TOKEN_PROGRAM_ID) ? unpackAccount(ammVaultAta, ataInfo, TOKEN_PROGRAM_ID).amount : 0n;
  return { curve, amm };
}

export async function accruingPumpFees(creator: string): Promise<VenueFees> {
  const { curve, amm } = await creatorVaultBalances(pubkey(creator));
  return { unswept: 0n, claimable: curve + amm };
}

/**
 * `collect_creator_fee` for the curve vault and PumpSwap `collect_coin_creator_fee` for the pool
 * vault, only the legs that hold something; payer == creator so the WSOL leg unwraps to native
 * SOL in the same transaction. `amount` is the wallet's actual lamport gain (tx fee excluded).
 */
export async function claimPumpFees(creator: Keypair): Promise<{ amount: bigint; hash: string | null }> {
  const { curve, amm } = await creatorVaultBalances(creator.publicKey);
  if (curve + amm === 0n) return { amount: 0n, hash: null };
  const all = await new OnlinePumpSdk(connection()).collectCoinCreatorFeeInstructions(creator.publicKey, creator.publicKey);
  const [curveLeg, ...ammLegs] = all;
  if (!curveLeg) throw new Error("pump sdk returned no collect instructions");
  const legs = [...(curve > 0n ? [curveLeg] : []), ...(amm > 0n ? ammLegs : [])];
  const res = await sendInstructions(creator, legs, { computeUnits: COMPUTE_UNITS.collectFees });
  const gained = lamportDelta(res.tx, creator.publicKey);
  return { amount: gained > 0n ? gained : 0n, hash: res.signature };
}
