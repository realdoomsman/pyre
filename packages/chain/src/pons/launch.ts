import { getAddress, parseEther, parseEventLogs, toHex, zeroAddress, type Address, type Hash, type Hex, type LocalAccount } from "viem";
import { publicClient, waitForSuccess, walletClient } from "../chain.js";
import { factoryAbi } from "./abi.js";
import { ponsAddresses } from "./addresses.js";
import type { TokenSocials } from "./read.js";

export interface LaunchParams {
  name: string;
  symbol: string;
  /** Image URL (`ipfs://…` or https). ≤512 bytes. */
  logo: string;
  description: string;
  socials?: Partial<TokenSocials>;
  /** Wallet that earns creator fees; for Pyre this is the app wallet that also sends the launch. */
  creatorFeeRecipient: Address;
  /** 32-byte CREATE2 salt; random when omitted. Reusing one with identical terms reverts. */
  salt?: Hex;
}

export interface LaunchResult {
  hash: Hash;
  token: Address;
  curve: Address;
  salt: Hex;
}

export interface LaunchCost {
  launchFeeWei: bigint;
  gasLimit: bigint;
  gasPriceWei: bigint;
  /** launchFee + gasLimit × gasPrice × 1.5 — what the treasury should pre-fund an app wallet with. */
  totalWei: bigint;
}

/** Exact `TokenParams` struct the factory takes. */
export interface TokenParams {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: TokenSocials;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  expectedEconomics: Hex;
  salt: Hex;
}

/** `canLaunch(sender)` returned false: the public gate is closed and the sender is not whitelisted. */
export class LaunchGatedError extends Error {
  constructor(public readonly launcher: Address) {
    super(`PONS v2 factory refuses launches from ${launcher} (canLaunch=false)`);
    this.name = "LaunchGatedError";
  }
}

/** Metadata caps enforced by the launch deployer (`MetadataTooLong`). */
const CAPS = { name: 64, symbol: 16, logo: 512, description: 2048, social: 256 } as const;
export const LAUNCH_CONFIG_ID = 0n;
const utf8 = new TextEncoder();

function checkLength(field: string, value: string, max: number): void {
  if (utf8.encode(value).length > max) throw new Error(`launch ${field} exceeds ${max} bytes`);
}

/** TokenParams tuple with Pyre's fixed policy: no creator tax, no PONS buybacks (Pyre burns on its own). */
export function buildTokenParams(params: LaunchParams, expectedEconomics: Hex, salt: Hex): TokenParams {
  checkLength("name", params.name, CAPS.name);
  checkLength("symbol", params.symbol, CAPS.symbol);
  checkLength("logo", params.logo, CAPS.logo);
  checkLength("description", params.description, CAPS.description);
  const socials: TokenSocials = {
    twitter: params.socials?.twitter ?? "",
    telegram: params.socials?.telegram ?? "",
    discord: params.socials?.discord ?? "",
    website: params.socials?.website ?? "",
    farcaster: params.socials?.farcaster ?? "",
  };
  for (const [k, v] of Object.entries(socials)) checkLength(`socials.${k}`, v, CAPS.social);
  return {
    name: params.name,
    symbol: params.symbol,
    logo: params.logo,
    description: params.description,
    socials,
    creatorFeeRecipient: getAddress(params.creatorFeeRecipient),
    creatorTaxBps: 0,
    buybackEnabled: false,
    expectedEconomics,
    salt,
  };
}

export const randomSalt = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Direct factory launch (`launchToken(params, 0, ETH)` with `value = launchFee()`), pinned to the
 * economics read immediately beforehand. Resolves once mined, with the token/curve from the
 * factory's `TokenLaunched` event.
 */
export async function launchPonsToken(account: LocalAccount, params: LaunchParams): Promise<LaunchResult> {
  const client = publicClient();
  const { factory } = ponsAddresses();
  const f = { address: factory, abi: factoryAbi } as const;
  const [allowed, launchFee, expectedEconomics] = await Promise.all([
    client.readContract({ ...f, functionName: "canLaunch", args: [account.address] }),
    client.readContract({ ...f, functionName: "launchFee" }),
    client.readContract({ ...f, functionName: "previewLaunchEconomics", args: [LAUNCH_CONFIG_ID, zeroAddress] }),
  ]);
  if (!allowed) throw new LaunchGatedError(account.address);
  const salt = params.salt ?? randomSalt();
  const tokenParams = buildTokenParams(params, expectedEconomics, salt);
  const hash = await walletClient(account).writeContract({
    ...f,
    functionName: "launchToken",
    args: [tokenParams, LAUNCH_CONFIG_ID, zeroAddress],
    value: launchFee,
  });
  const receipt = await waitForSuccess(hash, client);
  const launched = parseEventLogs({ abi: factoryAbi, eventName: "TokenLaunched", logs: receipt.logs })[0];
  if (!launched) throw new Error(`launch ${hash}: no TokenLaunched event`);
  return { hash, token: getAddress(launched.args.token), curve: getAddress(launched.args.curve), salt };
}

/**
 * Launch fee plus a gas estimate, simulated from `from` with a 1 ETH balance override so an
 * unfunded app wallet can be quoted before the treasury tops it up.
 */
export async function predictLaunchCost(from: Address, params?: LaunchParams): Promise<LaunchCost> {
  const client = publicClient();
  const { factory } = ponsAddresses();
  const f = { address: factory, abi: factoryAbi } as const;
  const [launchFeeWei, expectedEconomics, gasPriceWei] = await Promise.all([
    client.readContract({ ...f, functionName: "launchFee" }),
    client.readContract({ ...f, functionName: "previewLaunchEconomics", args: [LAUNCH_CONFIG_ID, zeroAddress] }),
    client.getGasPrice(),
  ]);
  const sample: LaunchParams = params ?? {
    name: "Pyre launch",
    symbol: "PYRE",
    logo: "https://pyre.fun/logo.png",
    description: "gas estimate",
    creatorFeeRecipient: from,
  };
  const gasLimit = await client.estimateContractGas({
    ...f,
    functionName: "launchToken",
    args: [buildTokenParams(sample, expectedEconomics, randomSalt()), LAUNCH_CONFIG_ID, zeroAddress],
    value: launchFeeWei,
    account: getAddress(from),
    stateOverride: [{ address: getAddress(from), balance: parseEther("1") }],
  });
  return { launchFeeWei, gasLimit, gasPriceWei, totalWei: launchFeeWei + (gasLimit * gasPriceWei * 3n) / 2n };
}
