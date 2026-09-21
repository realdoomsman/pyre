import type { Address, Hash, LocalAccount } from "viem";
import {
  BPS,
  curveBuy,
  curveSell,
  effectiveSnipeTaxBps,
  getErc20Balance,
  getEthPriceUsd,
  publicClient,
  quoteBuy,
  quoteSell,
  readCurveState,
  readLaunch,
  v4QuoteExactIn,
  v4SwapExactIn,
  withSlippage,
  type CurveState,
  type LaunchRecord,
  type SwapInput,
} from "@pyre/chain";
import { dec, prisma, type App, type User } from "@pyre/db";
import { LAUNCH_PHASE, type TradeBody, type TradeQuoteDto } from "@pyre/shared";
import { custodialAccount, custodialEthBalance, GAS_RESERVE_WEI } from "./custodial.js";
import { HttpError } from "./errors.js";
import { publishEvent, publishGlobal } from "./events.js";
import { logger } from "./logger.js";

/**
 * Custodial trading: the API quotes and executes buys/sells for users who hold their coins in
 * Pyre wallets, against the same venues PONS itself uses — the bonding curve before graduation
 * (`curve.buy/sell`) and the Uniswap v4 pool after (Universal Router exact-in). Slippage is a
 * hard on-chain bound (`minOut`), never a soft check.
 */

/** Widest slippage a caller may accept, explicit `minOut` included; mirrors `TradeBody.slippageBps.max`. */
const MAX_SLIPPAGE_BPS = 5000;

/** PONS meme-hook base fee on graduated pools: 1% of the ETH leg. */
export const POOL_FEE_BPS = 100n;

export type TradeApp = Pick<App, "id" | "slug" | "tokenAddress" | "curveAddress" | "launchPhase" | "status" | "priceUsd">;

/** Chain surface the trade logic needs; injected so quotes and slippage decisions are testable offline. */
export interface TradeChain {
  readLaunch: (token: Address) => Promise<LaunchRecord>;
  readCurveState: (curve: Address, recipient: Address) => Promise<CurveState>;
  v4QuoteExactIn: (launch: LaunchRecord, input: SwapInput) => Promise<bigint>;
  curveBuy: (account: LocalAccount, curve: Address, wei: bigint, minOut: bigint, recipient: Address) => Promise<{ hash: Hash; tokensOut: bigint; refundWei: bigint }>;
  curveSell: (account: LocalAccount, curve: Address, tokens: bigint, minOut: bigint, recipient: Address) => Promise<{ hash: Hash; quoteOut: bigint }>;
  v4SwapExactIn: (account: LocalAccount, launch: LaunchRecord, input: SwapInput, minOut: bigint, recipient: Address) => Promise<{ hash: Hash; out: bigint }>;
  ethBalance: (wallet: Address) => Promise<bigint>;
  tokenBalance: (token: Address, wallet: Address) => Promise<bigint>;
  ethPriceUsd: () => Promise<number>;
  receiptBlock: (hash: Hash) => Promise<bigint>;
}

export const liveTradeChain: TradeChain = {
  readLaunch,
  readCurveState,
  v4QuoteExactIn,
  curveBuy,
  curveSell,
  v4SwapExactIn,
  ethBalance: custodialEthBalance,
  tokenBalance: getErc20Balance,
  ethPriceUsd: getEthPriceUsd,
  receiptBlock: async (hash) => (await publicClient().getTransactionReceipt({ hash })).blockNumber,
};

const pctChange = (exec: number, spot: number): number => (spot > 0 && Number.isFinite(exec) ? ((exec - spot) / spot) * 100 : 0);

export interface QuoteContext {
  launch: LaunchRecord;
  ethPriceUsd: number;
  /** Curve reserves + fees, present in phase 0. */
  curve?: CurveState;
  /** Quoter output, present in phase 2. */
  poolOut?: bigint;
  /** Spot ETH per token for the pool (from the runner's price refresh), so v4 quotes can report impact. */
  spotEthPerToken?: number;
}

/**
 * Pure quote from already-read chain state. `minOut` is the caller's explicit floor or the quote
 * less `slippageBps`; a quote already below an explicit floor is rejected here so the user is not
 * charged gas for a transaction that would revert.
 */
export const buildQuote = (app: Pick<App, "slug">, body: TradeBody, ctx: QuoteContext): TradeQuoteDto => {
  const amountIn = BigInt(body.amount);
  if (amountIn <= 0n) throw new HttpError(400, "invalid_amount");
  const { launch, ethPriceUsd } = ctx;
  let amountOut: bigint;
  let feeWei: bigint;
  let refundWei = 0n;
  let snipeTaxBps = 0n;
  let priceImpactPct = 0;
  let venue: TradeQuoteDto["venue"];

  if (launch.phase === LAUNCH_PHASE.CURVE) {
    const state = ctx.curve;
    if (!state) throw new HttpError(503, "quote_unavailable");
    venue = "CURVE";
    const spot = state.tokenReserve > 0n ? Number(state.quoteReserve) / Number(state.tokenReserve) : 0;
    if (body.side === "buy") {
      const q = quoteBuy(state, amountIn);
      if (q.tokensOut <= 0n) throw new HttpError(400, "amount_too_small");
      snipeTaxBps = effectiveSnipeTaxBps(state);
      feeWei = (q.spent * (state.feeBps + state.creatorTaxBps + snipeTaxBps)) / BPS;
      amountOut = q.tokensOut;
      refundWei = q.refund;
      priceImpactPct = pctChange(Number(q.spent) / Number(q.tokensOut), spot);
    } else {
      const out = quoteSell(state, amountIn);
      if (out <= 0n) throw new HttpError(400, "amount_too_small");
      const gross = (amountIn * state.quoteReserve) / (state.tokenReserve + amountIn);
      feeWei = gross - out;
      amountOut = out;
      priceImpactPct = pctChange(Number(out) / Number(amountIn), spot);
    }
  } else if (launch.phase === LAUNCH_PHASE.POOL) {
    if (ctx.poolOut === undefined) throw new HttpError(503, "quote_unavailable");
    venue = "POOL";
    amountOut = ctx.poolOut;
    if (amountOut <= 0n) throw new HttpError(400, "amount_too_small");
    // The hook charges its base fee on the ETH leg: off the input for buys, off the output for sells.
    feeWei = body.side === "buy" ? (amountIn * POOL_FEE_BPS) / BPS : (amountOut * POOL_FEE_BPS) / (BPS - POOL_FEE_BPS);
    const spot = ctx.spotEthPerToken ?? 0;
    const exec = body.side === "buy" ? Number(amountIn) / Number(amountOut) : Number(amountOut) / Number(amountIn);
    priceImpactPct = pctChange(exec, spot);
  } else {
    throw new HttpError(409, "trading_paused", { phase: launch.phase });
  }

  const minOut = body.minOut !== undefined ? BigInt(body.minOut) : withSlippage(amountOut, body.slippageBps);
  if (minOut > amountOut) throw new HttpError(400, "slippage_exceeded", { amountOut: amountOut.toString(), minOut: minOut.toString() });
  // An explicit floor can tighten the tolerance but never loosen it past the schema's 50% ceiling:
  // a phished UI must not be able to turn a custodial trade into a 100%-slippage fill.
  const floor = withSlippage(amountOut, MAX_SLIPPAGE_BPS);
  if (minOut < floor) throw new HttpError(400, "min_out_too_low", { minOut: minOut.toString(), floor: floor.toString(), maxSlippageBps: MAX_SLIPPAGE_BPS });

  const execEthPerToken = body.side === "buy" ? Number(amountIn - refundWei) / Number(amountOut) : Number(amountOut) / Number(amountIn);
  return {
    slug: app.slug,
    side: body.side,
    venue,
    phase: launch.phase,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    minOut: minOut.toString(),
    feeWei: feeWei.toString(),
    snipeTaxBps: Number(snipeTaxBps),
    refundWei: refundWei.toString(),
    priceImpactPct,
    priceUsd: Number.isFinite(execEthPerToken) ? execEthPerToken * ethPriceUsd : 0,
    ethPriceUsd,
  };
};

/** Reads the venue state for `app` and quotes `body` for `recipient` (the snipe tax is keyed to the recipient). */
export const quoteTrade = async (app: TradeApp, recipient: Address, body: TradeBody, chain: TradeChain = liveTradeChain): Promise<{ quote: TradeQuoteDto; launch: LaunchRecord }> => {
  if (!app.tokenAddress) throw new HttpError(409, "app_not_launched");
  if (app.status !== "LIVE" && app.status !== "DORMANT") throw new HttpError(409, "app_not_live");
  const amountIn = BigInt(body.amount);
  if (amountIn <= 0n) throw new HttpError(400, "invalid_amount");
  const [launch, ethPriceUsd] = await Promise.all([chain.readLaunch(app.tokenAddress as Address), chain.ethPriceUsd()]);
  if (!launch.exists) throw new HttpError(409, "app_not_launched");
  const ctx: QuoteContext = { launch, ethPriceUsd, spotEthPerToken: ethPriceUsd > 0 ? app.priceUsd / ethPriceUsd : 0 };
  if (launch.phase === LAUNCH_PHASE.CURVE) ctx.curve = await chain.readCurveState(launch.curve, recipient);
  else if (launch.phase === LAUNCH_PHASE.POOL)
    ctx.poolOut = await chain.v4QuoteExactIn(launch, body.side === "buy" ? { ethIn: amountIn } : { tokensIn: amountIn });
  return { quote: buildQuote(app, body, ctx), launch };
};

export interface ExecutedTrade {
  txHash: Hash;
  block: bigint;
  tokenUnits: bigint;
  quoteWei: bigint;
  priceUsd: number;
}

/**
 * Executes a quoted trade from the user's custodial wallet. Balances are checked first (ETH for
 * the buy + gas, or tokens + gas for a sell) so a doomed transaction never pays gas; the on-chain
 * `minOut` is the quote's floor, so a price move past the tolerance reverts instead of filling.
 */
export const executeTrade = async (
  app: TradeApp,
  user: Pick<User, "id" | "wallet" | "walletIndex">,
  body: TradeBody,
  chain: TradeChain = liveTradeChain,
): Promise<{ quote: TradeQuoteDto; trade: ExecutedTrade }> => {
  if (!user.wallet) throw new HttpError(400, "wallet_required");
  const wallet = user.wallet as Address;
  const { quote, launch } = await quoteTrade(app, wallet, body, chain);
  const amountIn = BigInt(quote.amountIn);
  const minOut = BigInt(quote.minOut);

  const ethBalance = await chain.ethBalance(wallet);
  if (body.side === "buy") {
    const need = amountIn + GAS_RESERVE_WEI;
    if (ethBalance < need) throw new HttpError(400, "insufficient_balance", { asset: "ETH", haveWei: ethBalance.toString(), needWei: need.toString() });
  } else {
    if (ethBalance < GAS_RESERVE_WEI) throw new HttpError(400, "insufficient_gas", { haveWei: ethBalance.toString(), needWei: GAS_RESERVE_WEI.toString() });
    const tokenBalance = await chain.tokenBalance(launch.token, wallet);
    if (tokenBalance < amountIn) throw new HttpError(400, "insufficient_balance", { asset: "TOKEN", haveUnits: tokenBalance.toString(), needUnits: amountIn.toString() });
  }

  const account = custodialAccount(user);
  let txHash: Hash;
  let tokenUnits: bigint;
  let quoteWei: bigint;
  try {
    if (quote.venue === "CURVE") {
      if (body.side === "buy") {
        const r = await chain.curveBuy(account, launch.curve, amountIn, minOut, wallet);
        txHash = r.hash;
        tokenUnits = r.tokensOut;
        quoteWei = amountIn - r.refundWei;
      } else {
        const r = await chain.curveSell(account, launch.curve, amountIn, minOut, wallet);
        txHash = r.hash;
        tokenUnits = amountIn;
        quoteWei = r.quoteOut;
      }
    } else {
      const r = await chain.v4SwapExactIn(account, launch, body.side === "buy" ? { ethIn: amountIn } : { tokensIn: amountIn }, minOut, wallet);
      txHash = r.hash;
      tokenUnits = body.side === "buy" ? r.out : amountIn;
      quoteWei = body.side === "buy" ? amountIn : r.out;
    }
  } catch (err) {
    logger.error({ err, appId: app.id, userId: user.id, side: body.side }, "custodial trade failed");
    throw new HttpError(502, "trade_failed", { reason: err instanceof Error ? err.message.split("\n")[0] : "unknown" });
  }
  const block = await chain.receiptBlock(txHash);
  const priceUsd = tokenUnits > 0n ? (Number(quoteWei) / Number(tokenUnits)) * quote.ethPriceUsd : 0;
  return { quote, trade: { txHash, block, tokenUnits, quoteWei, priceUsd } };
};

/**
 * Persists a fill the API itself executed and fans it out. The runner's log indexer will see the
 * same fill; the `Trade` unique key makes the second insert a no-op. The holder snapshot for this
 * wallet is refreshed from chain so the position shows immediately instead of at the next sweep.
 */
export const recordTrade = async (
  app: TradeApp,
  wallet: Address,
  side: TradeBody["side"],
  venue: TradeQuoteDto["venue"],
  t: ExecutedTrade,
  chain: TradeChain = liveTradeChain,
) => {
  const sideRow = side === "buy" ? "BUY" : "SELL";
  const ts = new Date();
  await prisma.trade.createMany({
    data: [{ appId: app.id, txHash: t.txHash, block: t.block, ts, side: sideRow, venue, wallet, tokenUnits: dec(t.tokenUnits), quoteWei: dec(t.quoteWei), priceUsd: t.priceUsd }],
    skipDuplicates: true,
  });
  const row = await prisma.trade.findFirstOrThrow({ where: { appId: app.id, txHash: t.txHash, side: sideRow, wallet } });
  const balance = await chain.tokenBalance(app.tokenAddress as Address, wallet).catch(() => null);
  if (balance !== null) {
    await prisma.holderBalance.upsert({
      where: { appId_wallet: { appId: app.id, wallet } },
      create: { appId: app.id, wallet, amount: dec(balance) },
      update: { amount: dec(balance) },
    });
  }
  await publishEvent(app.id, {
    type: "TRADE",
    side: sideRow,
    wallet,
    tokenUnits: t.tokenUnits.toString(),
    quoteWei: t.quoteWei.toString(),
    priceUsd: t.priceUsd,
    txHash: t.txHash,
  });
  await publishGlobal(app.id);
  return row;
};
