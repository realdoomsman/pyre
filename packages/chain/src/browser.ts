/**
 * Browser-safe subset of `@pyre/chain` (`@pyre/chain/browser`): ABIs, addresses, pure curve
 * and pool math, calldata encoders and typed-data shapes. Nothing here reads the environment,
 * opens a socket, or touches Node — the node entry (`./index.ts`) layers env overrides and
 * clients on top of these primitives, so both sides share one implementation.
 */
import {
  concatHex,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isHex,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
} from "viem";
import { curveAbi, tokenAbi, universalRouterAbi } from "./pons/abi.js";

export {
  curveAbi,
  erc20Abi,
  escrowAbi,
  factoryAbi,
  hookAbi,
  permit2Abi,
  poolManagerAbi,
  stateViewAbi,
  tokenAbi,
  universalRouterAbi,
  usdgAbi,
  v4QuoterAbi,
} from "./pons/abi.js";

/* ---------------------------------- chain ---------------------------------- */

export const ROBINHOOD_CHAIN_ID = 4663;
export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

/**
 * Robinhood Chain (Arbitrum Nitro L2, ~0.1 s blocks, ETH gas). Not in `viem/chains`.
 * Sources: https://docs.robinhood.com/chain/connecting/ , https://docs.ponsfamily.com/
 */
export const defineRobinhoodChain = (rpcUrl: string = PUBLIC_RPC_URL): Chain =>
  defineChain({
    id: ROBINHOOD_CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL, apiUrl: `${EXPLORER_URL}/api` } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });

/** Chain definition for browser wallets (public RPC; the node client swaps in `RPC_URL`). */
export const pyreChain: Chain = defineRobinhoodChain();

export const explorerTxUrl = (hash: string): string => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddressUrl = (address: string): string => `${EXPLORER_URL}/address/${address}`;
export const ponsUrl = (token: string): string => `https://www.ponsfamily.com/launchpad/${token}`;

/* -------------------------------- addresses -------------------------------- */

export const DEAD_ADDRESS: Address = "0x000000000000000000000000000000000000dEaD";
export const USDG_ADDRESS: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_DECIMALS = 6;

export interface PonsAddresses {
  factory: Address;
  launchAndBuy: Address;
  feeEscrow: Address;
  memeHook: Address;
  buybackVault: Address;
  locker: Address;
  deployer: Address;
  poolManager: Address;
  universalRouter: Address;
  quoter: Address;
  stateView: Address;
  permit2: Address;
}

/**
 * PONS v2 + Uniswap v4 on Robinhood Chain (chain id 4663).
 * PONS: https://docs.ponsfamily.com/v2 ("Deployed addresses"), confirmed against the factory's
 * getters. Uniswap v4 periphery: https://developers.uniswap.org/docs/protocols/v4/deployments.
 */
export const PONS_ADDRESSES: Readonly<PonsAddresses> = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  launchAndBuy: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  memeHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  buybackVault: "0x42df2a798f82289E177311362e8f5ccC45c1219c",
  locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",
  deployer: "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  universalRouter: getAddress("0x8876789976decbfcbbbe364623c63652db8c0904"),
  quoter: getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
  stateView: getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

/* ---------------------------------- launch --------------------------------- */

/** `LaunchedToken.phase`: 0 curve, 1 swept (transient), 2 Uniswap v4 pool, 3 rescued. */
export type LaunchPhase = 0 | 1 | 2 | 3;

export interface LaunchRecord {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  /** Quote asset; zero address = native ETH. */
  pairToken: Address;
  phase: LaunchPhase;
  graduationThresholdWei: bigint;
  poolFee: number;
  tickSpacing: number;
  /** keccak256(abi.encode(PoolKey)) of the graduated Uniswap v4 pool (valid once phase ≥ 2, computable earlier). */
  poolId: Hex;
  buybackEnabled: boolean;
  creatorTaxBps: number;
  exists: boolean;
}

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Uniswap v4 sorts currencies by address; native ETH (zero address) is always currency0. */
export function poolKey(token: Address, pairToken: Address, poolFee: number, tickSpacing: number, hooks: Address = PONS_ADDRESSES.memeHook): PoolKey {
  const tokenIs0 = token.toLowerCase() < pairToken.toLowerCase();
  return { currency0: tokenIs0 ? token : pairToken, currency1: tokenIs0 ? pairToken : token, fee: poolFee, tickSpacing, hooks };
}

/** poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)) — per the PONS v2 docs. */
export function computePoolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export function launchPoolKey(launch: LaunchRecord, hooks: Address = PONS_ADDRESSES.memeHook): PoolKey {
  return poolKey(launch.token, launch.pairToken, launch.poolFee, launch.tickSpacing, hooks);
}

/** The factory's `getLaunchedToken` tuple, as viem decodes it. */
export interface LaunchedTokenTuple {
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: number;
  exists: boolean;
}

/** Normalises a raw factory record into a `LaunchRecord` (checksummed, pool id derived). */
export function launchRecordFrom(token: Address, rec: LaunchedTokenTuple, hooks: Address = PONS_ADDRESSES.memeHook): LaunchRecord {
  const launch: LaunchRecord = {
    token: getAddress(token),
    curve: getAddress(rec.curve),
    deployer: getAddress(rec.deployer),
    creatorFeeRecipient: getAddress(rec.creatorFeeRecipient),
    pairToken: getAddress(rec.pairToken),
    phase: rec.phase as LaunchPhase,
    graduationThresholdWei: rec.graduationThreshold,
    poolFee: rec.poolFee,
    tickSpacing: rec.tickSpacing,
    poolId: "0x",
    buybackEnabled: rec.buybackEnabled,
    creatorTaxBps: rec.creatorTaxBps,
    exists: rec.exists,
  };
  launch.poolId = computePoolId(launchPoolKey(launch, hooks));
  return launch;
}

const Q96 = 2 ** 96;

/**
 * Spot price of the launch token in the quote currency from a v4 sqrtPriceX96.
 * (sqrtP / 2^96)^2 = currency1 per currency0.
 */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint, tokenIsCurrency0: boolean): number {
  const ratio = (Number(sqrtPriceX96) / Q96) ** 2; // currency1 per currency0
  if (ratio === 0) return 0;
  return tokenIsCurrency0 ? ratio : 1 / ratio;
}

/* ----------------------------------- curve ---------------------------------- */

/**
 * Bonding-curve quotes replicate the curve's own integer arithmetic (PONS v2 docs, "Getting a
 * quote"). Buys take every fee off the input before pricing; sells are priced first and fees come
 * off the output. Only buys carry the snipe tax, keyed to the token recipient.
 */
export const BPS = 10_000n;

export interface CurveState {
  quoteReserve: bigint;
  tokenReserve: bigint;
  sellableTokens: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  /** `currentSnipeTaxBps(recipient)` — raw, before the cap applied in `quoteBuy`. */
  snipeTaxBps: bigint;
}

export interface BuyQuote {
  tokensOut: bigint;
  /** Quote actually consumed; `< quoteIn` only when the buy is clamped to `sellableTokens`. */
  spent: bigint;
  refund: bigint;
}

const amountOut = (inAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint => (inAmount * reserveOut) / (reserveIn + inAmount);
const amountIn = (outAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint => (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;

/** Snipe tax after the curve's cap (the buyer always nets at least 1% of spend). */
export function effectiveSnipeTaxBps(state: Pick<CurveState, "feeBps" | "creatorTaxBps" | "snipeTaxBps">): bigint {
  if (state.snipeTaxBps <= 0n) return 0n;
  const max = BPS - state.feeBps - state.creatorTaxBps - 100n;
  return state.snipeTaxBps > max ? max : state.snipeTaxBps;
}

/** Pure buy quote (quote asset in → launch token out). */
export function quoteBuy(state: CurveState, quoteIn: bigint): BuyQuote {
  const { quoteReserve, tokenReserve, sellableTokens, feeBps, creatorTaxBps } = state;
  const snipeBps = effectiveSnipeTaxBps(state);
  let spent = quoteIn;
  const fee = (spent * feeBps) / BPS;
  const tax = (spent * creatorTaxBps) / BPS;
  const snipeTax = (spent * snipeBps) / BPS;
  let tokensOut = amountOut(spent - fee - tax - snipeTax, quoteReserve, tokenReserve);
  // A buy that would cross the reserved allocation fills to the edge and the input is repriced
  // from the token side so the rest is refunded.
  if (tokensOut > sellableTokens) {
    tokensOut = sellableTokens;
    const net = amountIn(sellableTokens, quoteReserve, tokenReserve);
    const denominator = BPS - feeBps - creatorTaxBps - snipeBps;
    const grossed = (net * BPS + denominator - 1n) / denominator;
    spent = grossed < quoteIn ? grossed : quoteIn;
  }
  return { tokensOut, spent, refund: quoteIn - spent };
}

/** Pure sell quote (launch token in → quote asset out, fees off the output, no snipe tax). */
export function quoteSell(state: Pick<CurveState, "quoteReserve" | "tokenReserve" | "feeBps" | "creatorTaxBps">, tokensIn: bigint): bigint {
  const gross = amountOut(tokensIn, state.tokenReserve, state.quoteReserve);
  const fee = (gross * state.feeBps) / BPS;
  const tax = (gross * state.creatorTaxBps) / BPS;
  return gross - fee - tax;
}

/** Anything that can `readContract` — a viem public client over any transport (browser: the API's `/v1/rpc` proxy). */
export type ContractReader = Pick<PublicClient, "readContract">;

/** Reads everything a quote needs; five `eth_call`s, batched by the client when it multicalls. */
export async function readCurveState(curve: Address, recipient: Address, client: ContractReader): Promise<CurveState> {
  const c = { address: curve, abi: curveAbi } as const;
  const [reserves, sellableTokens, feeBps, creatorTaxBps, snipeTaxBps] = await Promise.all([
    client.readContract({ ...c, functionName: "getReserves" }),
    client.readContract({ ...c, functionName: "sellableTokens" }),
    client.readContract({ ...c, functionName: "feeBps" }),
    client.readContract({ ...c, functionName: "creatorTaxBps" }),
    client.readContract({ ...c, functionName: "currentSnipeTaxBps", args: [recipient] }),
  ]);
  return { quoteReserve: reserves[0], tokenReserve: reserves[1], sellableTokens, feeBps, creatorTaxBps, snipeTaxBps };
}

/** Applies a slippage bound in basis points to a quoted output. */
export const withSlippage = (out: bigint, slippageBps: number): bigint => (out * (BPS - BigInt(slippageBps))) / BPS;

/* ------------------------------- calldata ---------------------------------- */

/** A ready-to-send transaction request for a browser wallet (`eth_sendTransaction`). */
export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

/** `curve.buy(quoteIn, minTokensOut, recipient)` with `value = quoteIn` (native pair). */
export function encodeCurveBuy(curve: Address, wei: bigint, minTokensOut: bigint, recipient: Address): TxRequest {
  if (wei <= 0n) throw new Error("curve buy: amount must be positive");
  return {
    to: getAddress(curve),
    data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [wei, minTokensOut, getAddress(recipient)] }),
    value: wei,
  };
}

/** `curve.sell(tokensIn, minQuoteOut, recipient)`; the curve must hold an allowance first. */
export function encodeCurveSell(curve: Address, tokensIn: bigint, minQuoteOut: bigint, recipient: Address): TxRequest {
  if (tokensIn <= 0n) throw new Error("curve sell: amount must be positive");
  return {
    to: getAddress(curve),
    data: encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [tokensIn, minQuoteOut, getAddress(recipient)] }),
    value: 0n,
  };
}

/** `token.approve(spender, amount)`. */
export function encodeApprove(token: Address, spender: Address, amount: bigint): TxRequest {
  return { to: getAddress(token), data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [getAddress(spender), amount] }), value: 0n };
}

/* ------------------------------- Uniswap v4 -------------------------------- */

/**
 * Command byte (Universal Router `Commands.sol`):
 *   V4_SWAP = 0x10 — https://docs.uniswap.org/contracts/universal-router/technical-reference#v4_swap
 * Action bytes (v4-periphery `Actions.sol`, https://docs.uniswap.org/contracts/v4/quickstart/swap):
 *   SWAP_EXACT_IN_SINGLE = 0x06, TAKE = 0x0e, TAKE_ALL = 0x0f, SETTLE_ALL = 0x0c
 * Native ETH is currency 0x0 and travels as `msg.value`; ERC-20 input is pulled through Permit2.
 */
export const V4_SWAP = 0x10;
export const SWAP_EXACT_IN_SINGLE = 0x06;
export const SETTLE_ALL = 0x0c;
export const TAKE = 0x0e;
export const TAKE_ALL = 0x0f;

export type SwapInput = { ethIn: bigint; tokensIn?: undefined } | { tokensIn: bigint; ethIn?: undefined };

/** `IV4Router.ExactInputSingleParams` as an ABI parameter (what SWAP_EXACT_IN_SINGLE decodes). */
export const exactInputSingleParamsAbi = [
  {
    type: "tuple",
    components: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

export interface SwapDirection {
  key: PoolKey;
  inputCurrency: Address;
  outputCurrency: Address;
  amountIn: bigint;
  zeroForOne: boolean;
}

export function swapDirection(launch: LaunchRecord, input: SwapInput, hooks: Address = PONS_ADDRESSES.memeHook): SwapDirection {
  if (launch.phase !== 2) throw new Error(`launch ${launch.token} is not trading on Uniswap v4 (phase ${launch.phase})`);
  const key = launchPoolKey(launch, hooks);
  const inputCurrency = input.ethIn !== undefined ? launch.pairToken : launch.token;
  const outputCurrency = input.ethIn !== undefined ? launch.token : launch.pairToken;
  const amountIn = input.ethIn ?? input.tokensIn;
  if (amountIn <= 0n) throw new Error("v4 swap: amount must be positive");
  return { key, inputCurrency, outputCurrency, amountIn, zeroForOne: inputCurrency.toLowerCase() === key.currency0.toLowerCase() };
}

/** Encodes `execute()` inputs for one exact-in single-hop swap. */
export function encodeV4ExactInSingle(
  launch: LaunchRecord,
  input: SwapInput,
  minOut: bigint,
  sender: Address,
  recipient: Address,
  hooks: Address = PONS_ADDRESSES.memeHook,
): { commands: Hex; inputs: Hex[] } {
  const { key, inputCurrency, outputCurrency, amountIn, zeroForOne } = swapDirection(launch, input, hooks);
  const toSelf = recipient.toLowerCase() === sender.toLowerCase();
  const actions = concatHex([toHex(SWAP_EXACT_IN_SINGLE, { size: 1 }), toHex(SETTLE_ALL, { size: 1 }), toHex(toSelf ? TAKE_ALL : TAKE, { size: 1 })]);
  const params: Hex[] = [
    encodeAbiParameters(exactInputSingleParamsAbi, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: "0x" }]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [inputCurrency, amountIn]),
    toSelf
      ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [outputCurrency, minOut])
      : // amount 0 = ActionConstants.OPEN_DELTA: take the whole credit; minOut is already enforced by the swap.
        encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [outputCurrency, getAddress(recipient), 0n]),
  ];
  return { commands: toHex(V4_SWAP, { size: 1 }), inputs: [encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params])] };
}

/**
 * Full `UniversalRouter.execute(commands, inputs, deadline)` request. ETH input rides as `value`;
 * token input needs a Permit2 allowance (`token.approve(permit2)` + `permit2.approve(token, router)`).
 */
export function encodeV4Swap(
  launch: LaunchRecord,
  input: SwapInput,
  minOut: bigint,
  sender: Address,
  recipient: Address,
  deadline: bigint,
  addresses: Pick<PonsAddresses, "universalRouter" | "memeHook"> = PONS_ADDRESSES,
): TxRequest {
  const { commands, inputs } = encodeV4ExactInSingle(launch, input, minOut, sender, recipient, addresses.memeHook);
  return {
    to: addresses.universalRouter,
    data: encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline] }),
    value: input.ethIn ?? 0n,
  };
}

/** True when `launch.pairToken` is native ETH. */
export const isNativePair = (launch: Pick<LaunchRecord, "pairToken">): boolean => launch.pairToken === zeroAddress;

/* ------------------------------ USDG EIP-712 -------------------------------- */

export const USDG_EIP712_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface UsdgAuthorizationMessage {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface UsdgAuthorizationTypedData {
  domain: TypedDataDomain;
  types: typeof USDG_EIP712_TYPES;
  primaryType: "TransferWithAuthorization";
  message: UsdgAuthorizationMessage;
}

/** EIP-712 domain of USDG on Robinhood Chain; matches the on-chain `DOMAIN_SEPARATOR()`. */
export function usdgDomain(verifyingContract: Address = USDG_ADDRESS): TypedDataDomain {
  return { name: "Global Dollar", version: "1", chainId: ROBINHOOD_CHAIN_ID, verifyingContract };
}

/** Typed-data payload for `TransferWithAuthorization` — what a browser wallet signs via `eth_signTypedData_v4`. */
export function usdgAuthorizationTypedData(message: UsdgAuthorizationMessage, verifyingContract: Address = USDG_ADDRESS): UsdgAuthorizationTypedData {
  return { domain: usdgDomain(verifyingContract), types: USDG_EIP712_TYPES, primaryType: "TransferWithAuthorization", message };
}

/* ------------------------------ attestation -------------------------------- */

/**
 * Burn attestation: a zero-value self-transfer whose calldata is
 *   0x50595245 ("PYRE") || 0x01 (version) || sha256(revenue event ids)
 * so anyone can tie a buyback-and-burn to the revenue that funded it on the explorer.
 */
export const ATTESTATION_PREFIX: Hex = "0x5059524501";
const ATTESTATION_LENGTH = ATTESTATION_PREFIX.length + 64;

export function encodeAttestation(hash32: Hex): Hex {
  if (!isHex(hash32) || hash32.length !== 66) throw new Error("attestation hash must be 32 bytes");
  return `${ATTESTATION_PREFIX}${hash32.slice(2)}`;
}

/** The embedded hash when `txData` is a Pyre attestation, else null. */
export function parseAttestation(txData: Hex | string): Hex | null {
  if (typeof txData !== "string" || txData.length !== ATTESTATION_LENGTH) return null;
  if (!txData.toLowerCase().startsWith(ATTESTATION_PREFIX)) return null;
  const body = txData.slice(ATTESTATION_PREFIX.length);
  return /^[0-9a-fA-F]{64}$/.test(body) ? `0x${body.toLowerCase()}` : null;
}
