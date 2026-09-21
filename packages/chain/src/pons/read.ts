import { getAddress, zeroAddress, type Address } from "viem";
import {
  launchRecordFrom,
  poolKey as poolKeyWith,
  launchPoolKey as launchPoolKeyWith,
  priceFromSqrtPriceX96,
  type LaunchRecord,
  type PoolKey,
} from "../browser.js";
import { publicClient, type PyrePublicClient } from "../chain.js";
import { getEthPriceUsd } from "../price.js";
import { curveAbi, escrowAbi, factoryAbi, hookAbi, stateViewAbi, tokenAbi } from "./abi.js";
import { DEAD_ADDRESS, ponsAddresses } from "./addresses.js";

export { computePoolId, launchRecordFrom, priceFromSqrtPriceX96, type LaunchPhase, type LaunchRecord, type PoolKey } from "../browser.js";

export interface TokenSocials {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
}

export interface TokenInfo {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  logo: string;
  description: string;
  socials: TokenSocials;
  deployer: Address;
  /** Live `totalSupply()`; `burn()` on v2 tokens reduces it. */
  totalSupply: bigint;
  /** launchSupply − totalSupply + balance(0x…dEaD). */
  burnedUnits: bigint;
}

export interface PriceSnapshot {
  priceEth: number;
  priceUsd: number;
  /** priceUsd × circulating (totalSupply − dead balance). */
  mcapUsd: number;
  /** priceUsd × totalSupply. */
  fdvUsd: number;
  /** Curve progress 0–1 (realQuoteReserve / graduationThreshold); 1 once graduated. */
  progress: number;
  burnedUnits: bigint;
  circulatingUnits: bigint;
  totalSupply: bigint;
}

export interface AccruingFees {
  /** Fees sitting on the curve (phase 0) or the hook (phase 2), not yet swept into the escrow. */
  unsweptWei: bigint;
  /** Claimable escrow balance of the creatorFeeRecipient. */
  escrowWei: bigint;
}

export class UnsupportedPairError extends Error {
  constructor(public readonly pairToken: Address) {
    super(`launch is priced in ${pairToken}, not native ETH`);
    this.name = "UnsupportedPairError";
  }
}

/** Uniswap v4 sorts currencies by address; native ETH (zero address) is always currency0. */
export function poolKey(token: Address, pairToken: Address, poolFee: number, tickSpacing: number, hooks: Address = ponsAddresses().memeHook): PoolKey {
  return poolKeyWith(token, pairToken, poolFee, tickSpacing, hooks);
}

export function launchPoolKey(launch: LaunchRecord): PoolKey {
  return launchPoolKeyWith(launch, ponsAddresses().memeHook);
}

/** Factory launch record plus the derived pool id. `exists` is false for tokens this factory did not launch. */
export async function readLaunch(token: Address, client: PyrePublicClient = publicClient()): Promise<LaunchRecord> {
  const { factory, memeHook } = ponsAddresses();
  const rec = await client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [getAddress(token)] });
  return launchRecordFrom(token, rec, memeHook);
}

/**
 * Price + supply snapshot. Phase 0 prices off the curve's pricing reserves (phantom included, the
 * marginal price a tiny buy pays); phase 2 off the v4 pool's slot0. Phases 1/3 try the pool
 * first, then the curve, and report 0 when neither can price. Only native-ETH pairs are supported.
 */
export async function getPrice(launch: LaunchRecord, client: PyrePublicClient = publicClient()): Promise<PriceSnapshot> {
  if (launch.pairToken !== zeroAddress) throw new UnsupportedPairError(launch.pairToken);
  const { stateView } = ponsAddresses();
  const token = { address: launch.token, abi: tokenAbi } as const;
  const curve = { address: launch.curve, abi: curveAbi } as const;
  const tokenIs0 = launch.token.toLowerCase() < launch.pairToken.toLowerCase();

  const [ethUsd, totalSupply, deadBalance, launchSupply, reserves, realQuote, slot0] = await Promise.all([
    getEthPriceUsd(),
    client.readContract({ ...token, functionName: "totalSupply" }),
    client.readContract({ ...token, functionName: "balanceOf", args: [DEAD_ADDRESS] }),
    client.readContract({ ...curve, functionName: "launchSupply" }),
    client.readContract({ ...curve, functionName: "getReserves" }),
    client.readContract({ ...curve, functionName: "realQuoteReserve" }),
    launch.phase === 0
      ? Promise.resolve(undefined)
      : client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [launch.poolId] }).catch(() => undefined),
  ]);

  const [quoteReserve, tokenReserve] = reserves;
  let priceEth = 0;
  if (launch.phase === 0) {
    priceEth = tokenReserve > 0n ? Number(quoteReserve) / Number(tokenReserve) : 0;
  } else if (slot0 && slot0[0] > 0n) {
    priceEth = priceFromSqrtPriceX96(slot0[0], tokenIs0);
  } else if (tokenReserve > 0n) {
    priceEth = Number(quoteReserve) / Number(tokenReserve);
  }

  const circulatingUnits = totalSupply - deadBalance;
  const burnedUnits = launchSupply - totalSupply + deadBalance;
  const priceUsd = priceEth * ethUsd;
  const progress =
    launch.phase === 0 && launch.graduationThresholdWei > 0n ? Math.min(1, Number(realQuote) / Number(launch.graduationThresholdWei)) : 1;

  return {
    priceEth,
    priceUsd,
    mcapUsd: priceUsd * (Number(circulatingUnits) / 1e18),
    fdvUsd: priceUsd * (Number(totalSupply) / 1e18),
    progress,
    burnedUnits,
    circulatingUnits,
    totalSupply,
  };
}

/** Unswept (curve or hook) plus claimable (escrow) creator fees, in the quote currency. */
export async function accruingFees(launch: LaunchRecord, client: PyrePublicClient = publicClient()): Promise<AccruingFees> {
  const { feeEscrow, memeHook } = ponsAddresses();
  const escrowWei = client.readContract({ address: feeEscrow, abi: escrowAbi, functionName: "balanceOf", args: [launch.creatorFeeRecipient] });
  if (launch.phase === 2) {
    const hook = { address: memeHook, abi: hookAbi } as const;
    const [fees, tax, escrow] = await Promise.all([
      client.readContract({ ...hook, functionName: "pendingFees", args: [launch.poolId, launch.pairToken] }),
      client.readContract({ ...hook, functionName: "pendingCreatorTax", args: [launch.poolId, launch.pairToken] }),
      escrowWei,
    ]);
    return { unsweptWei: fees + tax, escrowWei: escrow };
  }
  const curve = { address: launch.curve, abi: curveAbi } as const;
  const [fees, tax, escrow] = await Promise.all([
    client.readContract({ ...curve, functionName: "quoteFeeBalance" }),
    client.readContract({ ...curve, functionName: "creatorTaxBalance" }),
    escrowWei,
  ]);
  return { unsweptWei: fees + tax, escrowWei: escrow };
}

/** ERC-20 metadata + creator metadata + burn accounting for a v2 launch token. */
export async function getTokenInfo(token: Address, client: PyrePublicClient = publicClient()): Promise<TokenInfo> {
  const address = getAddress(token);
  const t = { address, abi: tokenAbi } as const;
  const [name, symbol, decimals, totalSupply, deadBalance, info, curve] = await Promise.all([
    client.readContract({ ...t, functionName: "name" }),
    client.readContract({ ...t, functionName: "symbol" }),
    client.readContract({ ...t, functionName: "decimals" }),
    client.readContract({ ...t, functionName: "totalSupply" }),
    client.readContract({ ...t, functionName: "balanceOf", args: [DEAD_ADDRESS] }),
    client.readContract({ ...t, functionName: "getTokenInfo" }),
    client.readContract({ ...t, functionName: "curve" }),
  ]);
  const launchSupply = await client.readContract({ address: curve, abi: curveAbi, functionName: "launchSupply" });
  const [deployer, logo, description, socials] = info;
  return {
    address,
    name,
    symbol,
    decimals,
    logo,
    description,
    socials: { ...socials },
    deployer: getAddress(deployer),
    totalSupply,
    burnedUnits: launchSupply - totalSupply + deadBalance,
  };
}
