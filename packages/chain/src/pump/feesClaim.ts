import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurvePda,
  canonicalPumpPoolPda,
  creatorVaultPda,
  feeSharingConfigPda,
  hasCoinCreatorMigratedToSharingConfig,
} from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK, coinCreatorVaultAtaPda, coinCreatorVaultAuthorityPda } from "@pump-fun/pump-swap-sdk";
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

export interface PumpFeeShareholder {
  address: string;
  shareBps: number;
}

/**
 * Where a coin's creator fees go, seen from `recipient`:
 * - `creator`: `recipient` is the coin creator and collects with `claimPumpFees`;
 * - `shared`: the creator was migrated to the coin's fee-sharing config PDA (`creator`), fees are
 *   paid out to `shareholders` by the permissionless distribute; `treasuryShareBps` is
 *   `recipient`'s share (0 when it is not a shareholder);
 * - `foreign`: some other wallet is the creator; nothing reaches `recipient`.
 */
export type PumpCreatorFeeRoute =
  | { route: "creator"; creator: string }
  | { route: "shared"; creator: string; shareholders: PumpFeeShareholder[]; treasuryShareBps: number }
  | { route: "foreign"; creator: string };

/**
 * The coin's current creator — `Pool.coinCreator` once graduated, else `BondingCurve.creator`
 * (fee sharing rewrites both) — read with the SDK decoders that accept every live account size,
 * plus the sharing config when the creator has been migrated to it. One round trip.
 */
export async function pumpCreatorFeeRoute(mint: string, recipient: PublicKey): Promise<PumpCreatorFeeRoute> {
  const mintKey = pubkey(mint);
  const configKey = feeSharingConfigPda(mintKey);
  const [curveInfo, poolInfo, configInfo] = await connection().getMultipleAccountsInfo([bondingCurvePda(mintKey), canonicalPumpPoolPda(mintKey), configKey], SOLANA_COMMITMENT);
  const creator = (poolInfo ? PUMP_AMM_SDK.decodePoolNullable(poolInfo)?.coinCreator : undefined) ?? (curveInfo ? PUMP_SDK.decodeBondingCurveNullable(curveInfo)?.creator : undefined);
  if (!creator) throw new Error(`${mint} has no pump bonding curve or canonical pool`);
  if (creator.equals(recipient)) return { route: "creator", creator: creator.toBase58() };
  if (!hasCoinCreatorMigratedToSharingConfig({ mint: mintKey, creator })) return { route: "foreign", creator: creator.toBase58() };
  if (!configInfo) throw new Error(`${mint} creator is its sharing config ${configKey.toBase58()}, but that account does not exist`);
  const config = PUMP_SDK.decodeSharingConfig(configInfo);
  const treasuryShareBps = config.shareholders.reduce((sum, s) => (s.address.equals(recipient) ? sum + s.shareBps : sum), 0);
  return {
    route: "shared",
    creator: creator.toBase58(),
    shareholders: config.shareholders.map((s) => ({ address: s.address.toBase58(), shareBps: s.shareBps })),
    treasuryShareBps,
  };
}

export type PyreSolFeeClaim = PumpCreatorFeeRoute & { amount: bigint; hash: string | null };

/**
 * Collects one coin's creator fees for `treasury` along whichever route pump has them on:
 * creator → `claimPumpFees`; shared with `treasury` as a shareholder → the permissionless
 * distribute (preceded, for a graduated coin, by the pool-vault sweep into the curve vault),
 * paid by `treasury`, only when pump's own view says the vaults hold fees it can distribute
 * (that simulation already folds the pool vault in); otherwise nothing. `amount` is the
 * treasury's actual lamport gain (tx fee excluded), so a partial share counts only what it got.
 */
export async function claimPyreSolFees(treasury: Keypair, mint: string): Promise<PyreSolFeeClaim> {
  const route = await pumpCreatorFeeRoute(mint, treasury.publicKey);
  if (route.route === "creator") return { ...route, ...(await claimPumpFees(treasury)) };
  if (route.route === "foreign" || route.treasuryShareBps === 0) return { ...route, amount: 0n, hash: null };
  const mintKey = pubkey(mint);
  const sdk = new OnlinePumpSdk(connection());
  // `canDistribute` alone is true for an empty vault too (seen on mainnet), so also require fees to pay out.
  const { canDistribute, distributableFees } = await sdk.getMinimumDistributableFee(mintKey, treasury.publicKey, { payer: treasury.publicKey });
  if (!canDistribute || distributableFees.isZero()) return { ...route, amount: 0n, hash: null };
  const { instructions } = await sdk.buildDistributeCreatorFeesInstructions(mintKey, { payer: treasury.publicKey });
  const res = await sendInstructions(treasury, instructions, { computeUnits: COMPUTE_UNITS.distributeFees });
  const gained = lamportDelta(res.tx, treasury.publicKey);
  return { ...route, amount: gained > 0n ? gained : 0n, hash: res.signature };
}
