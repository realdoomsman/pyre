import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { HDKey } from "micro-key-producer/slip10.js";
import { platformMasterSeedHex } from "../env.js";
import { MAX_WALLET_INDEX, masterSeedBytes } from "../keys.js";

/**
 * Solana wallets are SLIP-0010 ed25519 children of the same master seed as the EVM tree, on the
 * Phantom/Solflare path shape `m/44'/501'/{account}'/0'` (coin type 501 keeps them disjoint from
 * the `m/44'/60'/…` EVM branches). SLIP-0010 ed25519 only has hardened children, so the user/app
 * split is folded into the account index instead of a separate branch:
 *
 *   user  i → m/44'/501'/{i}'/0'                (treasury = user 0)
 *   app   i → m/44'/501'/{1_000_000 + i}'/0'
 *
 * The app offset leaves room for a million users before the ranges could meet; `MAX_WALLET_INDEX`
 * (2^31 − 1) bounds both so no derivation ever wraps.
 */
export const SOL_APP_INDEX_OFFSET = 1_000_000;

export interface SolWallet {
  /** Base58 public key. */
  address: string;
  keypair: Keypair;
}

const masters = new Map<string, HDKey>();

function master(seedHex: string): HDKey {
  let hd = masters.get(seedHex);
  if (hd) return hd;
  hd = HDKey.fromMasterSeed(masterSeedBytes(seedHex));
  masters.set(seedHex, hd);
  return hd;
}

export const solDerivationPath = (account: number): string => `m/44'/501'/${account}'/0'`;

function derive(seedHex: string, account: number): SolWallet {
  if (!Number.isInteger(account) || account < 0 || account > MAX_WALLET_INDEX) throw new Error(`solana wallet account out of range: ${account}`);
  const child = master(seedHex).derive(solDerivationPath(account));
  const keypair = Keypair.fromSeed(child.privateKey);
  return { address: keypair.publicKey.toBase58(), keypair };
}

/** Custodial user wallet at m/44'/501'/{index}'/0'. Index 0 is the treasury. */
export function deriveSolWallet(index: number, seedHex: string = platformMasterSeedHex()): SolWallet {
  return derive(seedHex, index);
}

/** Per-app wallet (pump creator + launch payer) at m/44'/501'/{1000000 + appIndex}'/0'. */
export function deriveSolAppWallet(appIndex: number, seedHex: string = platformMasterSeedHex()): SolWallet {
  if (!Number.isInteger(appIndex) || appIndex < 0 || appIndex > MAX_WALLET_INDEX - SOL_APP_INDEX_OFFSET) throw new Error(`solana app index out of range: ${appIndex}`);
  return derive(seedHex, SOL_APP_INDEX_OFFSET + appIndex);
}

/** Platform treasury on Solana: user index 0. */
export function solTreasury(seedHex: string = platformMasterSeedHex()): SolWallet {
  return derive(seedHex, 0);
}

/** True for a base58 string that decodes to a 32-byte ed25519 public key. */
export function isSolAddress(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/** True for a base58 string that decodes to a 64-byte transaction signature. */
export function isSolSignature(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

/** `PublicKey` from a base58 string with a clear error for a malformed address. */
export function pubkey(address: string): PublicKey {
  if (!isSolAddress(address)) throw new Error(`not a solana address: ${address}`);
  return new PublicKey(address);
}
