import {
  createPublicClient,
  http,
  maxUint160,
  maxUint256,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import {
  BPS,
  PONS_ADDRESSES,
  effectiveSnipeTaxBps,
  encodeApprove,
  encodeCurveBuy,
  encodeCurveSell,
  encodeV4Swap,
  erc20Abi,
  factoryAbi,
  launchRecordFrom,
  permit2Abi,
  priceFromSqrtPriceX96,
  pyreChain,
  quoteBuy,
  quoteSell,
  readCurveState,
  stateViewAbi,
  swapDirection,
  v4QuoterAbi,
  withSlippage,
  type LaunchRecord,
  type TxRequest,
} from "@pyre/chain/browser";
import type { AppDetailDto, TradeQuoteDto } from "@pyre/shared";
import { env } from "../../env.js";
import { getWalletClient, type Eip1193Provider } from "../../lib/wallet.js";

/*
 * External-wallet trading. Reads go through the API's JSON-RPC proxy
 * (`POST /v1/rpc`, eth_call only) so the browser never touches the public
 * RPC; writes are signed by the injected wallet from calldata built with
 * `@pyre/chain/browser`. Custodial users never reach this file — the server
 * quotes and signs for them.
 */

export type Side = "buy" | "sell";

/** What the panel renders, whichever wallet produced it. */
export interface Quote {
  venue: "CURVE" | "POOL";
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  feeWei: bigint;
  snipeTaxBps: number;
  refundWei: bigint;
  priceImpactPct: number;
}

export const fromServerQuote = (q: TradeQuoteDto): Quote => ({
  venue: q.venue,
  amountIn: BigInt(q.amountIn),
  amountOut: BigInt(q.amountOut),
  minOut: BigInt(q.minOut),
  feeWei: BigInt(q.feeWei),
  snipeTaxBps: q.snipeTaxBps,
  refundWei: BigInt(q.refundWei),
  priceImpactPct: q.priceImpactPct,
});

let reader: PublicClient | undefined;

/** Read-only client over the API proxy; multicall folds the curve reads into one `eth_call`. */
export const rpcClient = (): PublicClient => {
  reader ??= createPublicClient({ chain: pyreChain, transport: http(`${env.apiOrigin}/v1/rpc`, { batch: false, retryCount: 2 }), batch: { multicall: true } });
  return reader;
};

export interface Market {
  token: Address;
  curve: Address;
  phase: number;
}

const marketOf = (app: AppDetailDto): Market => {
  if (!app.tokenAddress || !app.curveAddress) throw new Error("this coin has not launched yet");
  return { token: app.tokenAddress, curve: app.curveAddress, phase: app.phase };
};

const launchCache: Record<string, Promise<LaunchRecord>> = {};

/** Factory record for a graduated launch (pool key, fee, tick spacing); cached per token. */
export const readLaunch = (token: Address): Promise<LaunchRecord> => {
  launchCache[token] ??= rpcClient()
    .readContract({ address: PONS_ADDRESSES.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] })
    .then((rec) => launchRecordFrom(token, rec));
  return launchCache[token]!;
};

export const balancesOf = async (token: Address, owner: Address): Promise<{ ethWei: bigint; units: bigint }> => {
  const client = rpcClient();
  const [ethWei, units] = await Promise.all([client.getBalance({ address: owner }), client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] })]);
  return { ethWei, units };
};

/** Quote from chain state for the connected wallet (snipe tax is keyed to the recipient). */
export async function quoteExternal(app: AppDetailDto, side: Side, amount: bigint, slippageBps: number, recipient: Address): Promise<Quote> {
  const market = marketOf(app);
  if (amount <= 0n) throw new Error("amount must be positive");
  const client = rpcClient();

  if (market.phase === 0) {
    const state = await readCurveState(market.curve, recipient, client);
    if (side === "buy") {
      const q = quoteBuy(state, amount);
      const snipe = effectiveSnipeTaxBps(state);
      const feeWei = (q.spent * (state.feeBps + state.creatorTaxBps + snipe)) / BPS;
      const spot = Number(state.quoteReserve) / Number(state.tokenReserve);
      const effective = q.tokensOut > 0n ? Number(q.spent) / Number(q.tokensOut) : spot;
      return {
        venue: "CURVE",
        amountIn: amount,
        amountOut: q.tokensOut,
        minOut: withSlippage(q.tokensOut, slippageBps),
        feeWei,
        snipeTaxBps: Number(snipe),
        refundWei: q.refund,
        priceImpactPct: spot > 0 ? (effective / spot - 1) * 100 : 0,
      };
    }
    const out = quoteSell(state, amount);
    const gross = (amount * state.quoteReserve) / (state.tokenReserve + amount);
    const spot = Number(state.quoteReserve) / Number(state.tokenReserve);
    const effective = Number(gross) / Number(amount);
    return {
      venue: "CURVE",
      amountIn: amount,
      amountOut: out,
      minOut: withSlippage(out, slippageBps),
      feeWei: gross - out,
      snipeTaxBps: 0,
      refundWei: 0n,
      priceImpactPct: spot > 0 ? (1 - effective / spot) * 100 : 0,
    };
  }

  const launch = await readLaunch(market.token);
  const input = side === "buy" ? { ethIn: amount } : { tokensIn: amount };
  const { key, zeroForOne } = swapDirection(launch, input);
  const [{ result }, slot0] = await Promise.all([
    client.simulateContract({
      address: PONS_ADDRESSES.quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amount, hookData: "0x" }],
    }),
    client.readContract({ address: PONS_ADDRESSES.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [launch.poolId] }),
  ]);
  const amountOut = result[0];
  const tokenIs0 = key.currency0.toLowerCase() === launch.token.toLowerCase();
  const spot = priceFromSqrtPriceX96(slot0[0], tokenIs0); // ETH per token
  const effective = side === "buy" ? Number(amount) / Number(amountOut || 1n) : Number(amountOut) / Number(amount);
  const impact = spot > 0 ? (side === "buy" ? effective / spot - 1 : 1 - effective / spot) * 100 : 0;
  // The hook takes its 1% fee off the unspecified side; surface it so the panel is honest about cost.
  const feeWei = side === "buy" ? amount / 100n : amountOut / 99n;
  return { venue: "POOL", amountIn: amount, amountOut, minOut: withSlippage(amountOut, slippageBps), feeWei, snipeTaxBps: 0, refundWei: 0n, priceImpactPct: impact };
}

export interface ExternalWallet {
  address: Address;
  provider: Eip1193Provider;
}

export interface ExecuteResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

const RECEIPT_POLL_MS = 400;
const RECEIPT_TIMEOUT_MS = 120_000;

/** Polls `eth_getTransactionReceipt` at block cadence; the proxy allows nothing fancier. */
export async function waitForReceipt(hash: Hash, client: PublicClient = rpcClient()): Promise<TransactionReceipt> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) {
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
      return receipt;
    }
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, RECEIPT_POLL_MS);
    await tick.promise;
  }
  throw new Error(`transaction ${hash} was not mined within ${RECEIPT_TIMEOUT_MS / 1000}s`);
}

const send = async (wallet: WalletClient, from: Address, tx: TxRequest): Promise<Hash> =>
  wallet.sendTransaction({ account: from, chain: wallet.chain, to: tx.to, data: tx.data, value: tx.value });

/**
 * Signs and submits the trade from the injected wallet. `onSubmitted` fires
 * with the trade hash as soon as the wallet returns it (approvals are awaited
 * silently first); resolves once the trade is mined.
 */
export async function executeExternal(
  app: AppDetailDto,
  side: Side,
  quote: Quote,
  wallet: ExternalWallet,
  onSubmitted: (hash: Hash) => void,
): Promise<ExecuteResult> {
  const market = marketOf(app);
  const client = rpcClient();
  const signer = await getWalletClient(wallet.provider, wallet.address);
  const from = wallet.address;

  let hash: Hash;
  if (market.phase === 0) {
    if (side === "buy") {
      hash = await send(signer, from, encodeCurveBuy(market.curve, quote.amountIn, quote.minOut, from));
    } else {
      const allowance = await client.readContract({ address: market.token, abi: erc20Abi, functionName: "allowance", args: [from, market.curve] });
      if (allowance < quote.amountIn) await waitForReceipt(await send(signer, from, encodeApprove(market.token, market.curve, quote.amountIn)), client);
      hash = await send(signer, from, encodeCurveSell(market.curve, quote.amountIn, quote.minOut, from));
    }
  } else {
    const launch = await readLaunch(market.token);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    if (side === "buy") {
      hash = await send(signer, from, encodeV4Swap(launch, { ethIn: quote.amountIn }, quote.minOut, from, from, deadline));
    } else {
      const { permit2, universalRouter } = PONS_ADDRESSES;
      const erc20Allowance = await client.readContract({ address: market.token, abi: erc20Abi, functionName: "allowance", args: [from, permit2] });
      if (erc20Allowance < quote.amountIn) await waitForReceipt(await send(signer, from, encodeApprove(market.token, permit2, maxUint256)), client);
      const [allowed, expiration] = await client.readContract({ address: permit2, abi: permit2Abi, functionName: "allowance", args: [from, market.token, universalRouter] });
      const now = Math.floor(Date.now() / 1000);
      if (allowed < quote.amountIn || expiration <= now + 60) {
        const approveHash = await signer.writeContract({
          account: from,
          chain: signer.chain,
          address: permit2,
          abi: permit2Abi,
          functionName: "approve",
          args: [market.token, universalRouter, maxUint160, now + 30 * 24 * 3600],
        });
        await waitForReceipt(approveHash, client);
      }
      hash = await send(signer, from, encodeV4Swap(launch, { tokensIn: quote.amountIn }, quote.minOut, from, from, deadline));
    }
  }
  onSubmitted(hash);
  const receipt = await waitForReceipt(hash, client);
  return { hash, receipt };
}

const NICE: Record<string, string> = {
  insufficient_balance: "Not enough balance in your Pyre wallet — deposit first.",
  insufficient_eth_for_gas: "Not enough ETH left for gas.",
  slippage_exceeded: "Price moved past your slippage tolerance. Try again or raise slippage.",
  amount_too_small: "That amount is too small.",
  invalid_amount: "Enter a valid amount.",
  not_tradable: "This coin is not tradable right now.",
  curve_graduated: "The curve has graduated; trades now clear on Uniswap v4.",
};

/** A sentence for a toast: wallet rejections, API codes and revert reasons all read as one line. */
export const describeError = (e: unknown): string => {
  if (typeof e === "object" && e !== null) {
    if ("code" in e && (e.code === 4001 || e.code === "ACTION_REJECTED")) return "You rejected the request in your wallet.";
    if ("shortMessage" in e && typeof e.shortMessage === "string" && e.shortMessage) return e.shortMessage;
    if ("error" in e && typeof e.error === "string" && NICE[e.error]) return NICE[e.error]!;
  }
  if (e instanceof Error) return NICE[e.message] ?? e.message;
  return typeof e === "string" ? e : "Something went wrong.";
};
