import { getAddress, hexToBytes, toHex, type Address, type PrivateKeyAccount } from "viem";
import { HDKey, privateKeyToAccount } from "viem/accounts";
import { platformMasterSeedHex } from "./env.js";

/**
 * Custodial wallets are BIP-32 children of one master seed. Users and apps live on different
 * BIP-44 account branches, so User.walletIndex and App.keypairIndex (independent autoincrement
 * sequences) can never derive the same key.
 *
 *   user  i → m/44'/60'/0'/0/i   (treasury = user 0)
 *   app   i → m/44'/60'/1'/0/i
 */
export const USER_BRANCH = 0;
export const APP_BRANCH = 1;

export interface DerivedWallet {
  address: Address;
  account: PrivateKeyAccount;
}

const MAX_INDEX = 0x7fffffff;
const masters = new Map<string, HDKey>();

function master(seedHex: string): HDKey {
  let hd = masters.get(seedHex);
  if (hd) return hd;
  const clean = seedHex.startsWith("0x") ? seedHex.slice(2) : seedHex;
  // BIP-32 master seeds are 16–64 bytes: 32 bytes for a generated platform seed, 64 when it came
  // out of a BIP-39 mnemonic.
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0 || clean.length < 32 || clean.length > 128) {
    throw new Error("master seed must be 16–64 bytes of hex");
  }
  hd = HDKey.fromMasterSeed(hexToBytes(`0x${clean}`));
  masters.set(seedHex, hd);
  return hd;
}

function derive(seedHex: string, branch: number, index: number): DerivedWallet {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new Error(`wallet index out of range: ${index}`);
  const child = master(seedHex).derive(`m/44'/60'/${branch}'/0/${index}`);
  if (!child.privateKey) throw new Error(`no private key for branch ${branch} index ${index}`);
  const account = privateKeyToAccount(toHex(child.privateKey));
  return { address: getAddress(account.address), account };
}

/** Custodial user wallet at m/44'/60'/0'/0/{index}. Index 0 is the treasury. */
export function deriveWallet(index: number, seedHex: string = platformMasterSeedHex()): DerivedWallet {
  return derive(seedHex, USER_BRANCH, index);
}

/** Per-app wallet (PONS launcher + creatorFeeRecipient) at m/44'/60'/1'/0/{appIndex}. */
export function deriveAppWallet(appIndex: number, seedHex: string = platformMasterSeedHex()): DerivedWallet {
  return derive(seedHex, APP_BRANCH, appIndex);
}

/** Platform treasury: user index 0. */
export function treasury(seedHex: string = platformMasterSeedHex()): DerivedWallet {
  return derive(seedHex, USER_BRANCH, 0);
}
