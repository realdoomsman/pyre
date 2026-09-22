import { getAddress, isAddress, zeroAddress, type Address, type Hash, type Hex, type LocalAccount } from "viem";
import { EXPLORER_URL, ponsUrl } from "../browser.js";
import { attestBurn, attestationHash, burnTokens, parseAttestation } from "../burn.js";
import { getTrades } from "../candles.js";
import { publicClient } from "../chain.js";
import { getHolders } from "../holders.js";
import { deriveAppWallet, deriveWallet, treasury, type DerivedWallet } from "../keys.js";
import { getEthPriceUsd } from "../price.js";
import { getErc20Balance, getEthBalance, transferErc20, transferEth, verifyEthTransfer } from "../transfer.js";
import type { VenueAccount, VenueAdapter, VenueHolder, VenueInfo, VenueLaunchState, VenueQuote } from "../venue.js";
import { factoryAbi, curveAbi } from "./abi.js";
import { ponsAddresses } from "./addresses.js";
import { curveBuy, curveQuoteSell, curveSell, effectiveSnipeTaxBps, quoteBuy as curveQuote, readCurveState, type CurveState } from "./curve.js";
import { claimEscrow, sweepCreatorFees } from "./fees.js";
import { launchPonsToken, predictLaunchCost } from "./launch.js";
import { accruingFees, getPrice, readLaunch, type LaunchRecord } from "./read.js";
import { v4QuoteExactIn, v4SwapExactIn } from "./v4.js";

/**
 * Robinhood Chain + PONS v2 behind the venue interface. Every method delegates to the existing
 * module functions unchanged; the api and runner keep calling those directly where they already
 * do, and go through here where they dispatch by venue.
 */
export const PONS_INFO: VenueInfo = {
  chain: "robinhood",
  launchpad: "pons_v2",
  native: { symbol: "ETH", decimals: 18 },
  tokenDecimals: 18,
  totalSupplyUnits: 1_000_000_000n * 10n ** 18n,
  chainLabel: "Robinhood Chain",
  launchpadLabel: "pons v2",
  explorerTxUrl: (tx) => `${EXPLORER_URL}/tx/${tx}`,
  explorerAddressUrl: (address) => `${EXPLORER_URL}/address/${address}`,
  explorerTokenUrl: (token) => `${EXPLORER_URL}/token/${token}`,
  launchpadUrl: ponsUrl,
};

const account = (w: DerivedWallet): VenueAccount => ({ chain: "robinhood", address: w.address, signer: w.account });

/** The viem local account behind a Robinhood `VenueAccount`. */
export function evmSigner(acct: VenueAccount): LocalAccount {
  if (acct.chain !== "robinhood") throw new Error(`expected a robinhood account, got ${acct.chain}`);
  return acct.signer as LocalAccount;
}

const isTxHash = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value);

async function receiptBlock(hash: Hash): Promise<number> {
  return Number((await publicClient().getTransactionReceipt({ hash })).blockNumber);
}

async function launchState(launch: LaunchRecord): Promise<VenueLaunchState> {
  const client = publicClient();
  const [price, realQuote] = await Promise.all([getPrice(launch, client), client.readContract({ address: launch.curve, abi: curveAbi, functionName: "realQuoteReserve" })]);
  return {
    exists: launch.exists,
    token: launch.token,
    curve: launch.curve,
    pool: launch.phase >= 2 ? launch.poolId : null,
    phase: launch.phase,
    progress: price.progress,
    raisedNative: realQuote,
    graduationNative: launch.graduationThresholdWei,
    priceNative: price.priceEth,
    totalSupplyUnits: price.totalSupply,
    circulatingUnits: price.circulatingUnits,
    burnedUnits: price.burnedUnits,
  };
}

/** Curve fee bps as the PONS curve charges them (base fee + creator tax, plus the snipe tax on buys). */
function curveFeeBps(state: CurveState, side: "buy" | "sell"): number {
  return Number(state.feeBps + state.creatorTaxBps + (side === "buy" ? effectiveSnipeTaxBps(state) : 0n));
}

const impactOf = (execPrice: number, spot: number): number => (spot > 0 && Number.isFinite(execPrice) ? Math.abs(execPrice / spot - 1) : 0);

async function quoteBuy(token: Address, spendWei: bigint, buyer: Address): Promise<VenueQuote> {
  const launch = await readLaunch(token);
  if (launch.phase === 0) {
    const state = await readCurveState(launch.curve, buyer);
    const q = curveQuote(state, spendWei);
    const spot = state.tokenReserve > 0n ? Number(state.quoteReserve) / Number(state.tokenReserve) : 0;
    const exec = q.tokensOut > 0n ? Number(q.spent) / Number(q.tokensOut) : 0;
    return { native: q.spent, tokenUnits: q.tokensOut, priceNative: exec, feeBps: curveFeeBps(state, "buy"), impact: impactOf(exec, spot) };
  }
  const [out, price] = await Promise.all([v4QuoteExactIn(launch, { ethIn: spendWei }), getPrice(launch)]);
  const exec = out > 0n ? Number(spendWei) / Number(out) : 0;
  return { native: spendWei, tokenUnits: out, priceNative: exec, feeBps: 100 + launch.creatorTaxBps, impact: impactOf(exec, price.priceEth) };
}

async function quoteSell(token: Address, tokenUnits: bigint): Promise<VenueQuote> {
  const launch = await readLaunch(token);
  if (launch.phase === 0) {
    const [state, out] = await Promise.all([readCurveState(launch.curve, treasury().address), curveQuoteSell(launch.curve, tokenUnits)]);
    const spot = state.tokenReserve > 0n ? Number(state.quoteReserve) / Number(state.tokenReserve) : 0;
    const exec = tokenUnits > 0n ? Number(out) / Number(tokenUnits) : 0;
    return { native: out, tokenUnits, priceNative: exec, feeBps: curveFeeBps(state, "sell"), impact: impactOf(exec, spot) };
  }
  const [out, price] = await Promise.all([v4QuoteExactIn(launch, { tokensIn: tokenUnits }), getPrice(launch)]);
  const exec = tokenUnits > 0n ? Number(out) / Number(tokenUnits) : 0;
  return { native: out, tokenUnits, priceNative: exec, feeBps: 100 + launch.creatorTaxBps, impact: impactOf(exec, price.priceEth) };
}

const holderTag = (system: VenueHolder["system"] | "curve" | "locker" | "pool-manager" | "buyback-vault" | "dead"): VenueHolder["system"] => {
  switch (system) {
    case "curve":
    case "pool-manager":
      return "liquidity";
    case "locker":
      return "locked";
    case "buyback-vault":
      return "vault";
    case "dead":
      return "dead";
    default:
      return null;
  }
};

export const ponsAdapter: VenueAdapter = {
  info: PONS_INFO,

  treasury: () => account(treasury()),
  userWallet: (walletIndex) => account(deriveWallet(walletIndex)),
  appWallet: (keypairIndex) => account(deriveAppWallet(keypairIndex)),
  isAddress: (value) => isAddress(value, { strict: false }),
  isTxHash,

  nativeBalance: (address) => getEthBalance(getAddress(address)),
  transferNative: async (from, to, amount) => {
    const hash = await transferEth(evmSigner(from), getAddress(to), amount);
    return { hash, block: await receiptBlock(hash) };
  },
  verifyNativeTransfer: async (hash, to, minAmount, from) => {
    const check = await verifyEthTransfer(hash as Hash, { to: getAddress(to), minWei: minAmount, from: from ? getAddress(from) : undefined });
    return { ok: check.ok, from: check.from, amount: check.wei, reason: check.reason };
  },
  nativePriceUsd: getEthPriceUsd,

  predictLaunchCost: async (from) => (await predictLaunchCost(getAddress(from))).totalWei,
  canLaunch: async (from) => {
    const ok = await publicClient().readContract({ address: ponsAddresses().factory, abi: factoryAbi, functionName: "canLaunch", args: [getAddress(from)] });
    return ok ? { ok } : { ok, reason: "pons launch gate is closed for this wallet" };
  },
  launch: async (from, params) => {
    const signer = evmSigner(from);
    const result = await launchPonsToken(signer, {
      name: params.name,
      symbol: params.symbol,
      logo: params.imageUrl,
      description: params.description,
      socials: { twitter: params.socials.twitter, website: params.socials.website },
      creatorFeeRecipient: signer.address,
    });
    return { hash: result.hash, block: await receiptBlock(result.hash), token: result.token, curve: result.curve };
  },
  readLaunch: async (token) => launchState(await readLaunch(getAddress(token))),

  accruingFees: async (token) => {
    const fees = await accruingFees(await readLaunch(getAddress(token)));
    return { unswept: fees.unsweptWei, claimable: fees.escrowWei };
  },
  sweepFees: async (acct, token) => sweepCreatorFees(evmSigner(acct), await readLaunch(getAddress(token))),
  claimFees: async (acct) => {
    const r = await claimEscrow(evmSigner(acct));
    return { amount: r.wei, hash: r.hash ?? null };
  },

  quoteBuy: (token, spend, buyer) => quoteBuy(getAddress(token), spend, buyer ? getAddress(buyer) : zeroAddress),
  quoteSell: (token, units) => quoteSell(getAddress(token), units),
  buy: async (acct, token, spend, minTokenUnits) => {
    const signer = evmSigner(acct);
    const launch = await readLaunch(getAddress(token));
    if (launch.phase === 0) {
      const r = await curveBuy(signer, launch.curve, spend, minTokenUnits, signer.address);
      return { hash: r.hash, block: await receiptBlock(r.hash), tokenUnits: r.tokensOut, spentNative: spend - r.refundWei };
    }
    const r = await v4SwapExactIn(signer, launch, { ethIn: spend }, minTokenUnits, signer.address);
    return { hash: r.hash, block: await receiptBlock(r.hash), tokenUnits: r.out, spentNative: spend };
  },
  sell: async (acct, token, units, minNative) => {
    const signer = evmSigner(acct);
    const launch = await readLaunch(getAddress(token));
    if (launch.phase === 0) {
      const r = await curveSell(signer, launch.curve, units, minNative, signer.address);
      return { hash: r.hash, block: await receiptBlock(r.hash), receivedNative: r.quoteOut };
    }
    const r = await v4SwapExactIn(signer, launch, { tokensIn: units }, minNative, signer.address);
    return { hash: r.hash, block: await receiptBlock(r.hash), receivedNative: r.out };
  },
  tokenBalance: (token, address) => getErc20Balance(getAddress(token), getAddress(address)),
  transferToken: async (from, token, to, units) => {
    const hash = await transferErc20(evmSigner(from), getAddress(token), getAddress(to), units);
    return { hash, block: await receiptBlock(hash) };
  },

  burn: async (acct, token, units) => {
    const hash = await burnTokens(evmSigner(acct), getAddress(token), units);
    return { hash, block: await receiptBlock(hash), burnedUnits: units };
  },
  attest: async (acct, digestHex) => {
    const hash = await attestBurn(evmSigner(acct), (digestHex.startsWith("0x") ? digestHex : `0x${digestHex}`) as Hex);
    return { hash, block: await receiptBlock(hash) };
  },
  readAttestation: async (hash) => {
    const tx = await publicClient()
      .getTransaction({ hash: hash as Hash })
      .catch(() => undefined);
    const digestHex = tx ? parseAttestation(tx.input) : null;
    return digestHex ? { digestHex, version: 1 } : null;
  },

  currentBlock: async () => Number(await publicClient().getBlockNumber()),
  trades: async (token, fromBlock, toBlock) => getTrades(await readLaunch(getAddress(token)), BigInt(fromBlock), BigInt(toBlock)),
  holders: async (token, limit) => (await getHolders(getAddress(token), limit)).map((h) => ({ address: h.address, units: h.units, share: h.share, system: holderTag(h.system) })),
};

export { attestationHash };
