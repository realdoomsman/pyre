import { describe, expect, it, vi, type Mock } from "vitest";
import type { Address, Hash } from "viem";

/**
 * Custodial trading. The quote replicates the curve's own arithmetic (via @pyre/chain's pure
 * quoteBuy/quoteSell) and the slippage floor is what goes on chain as `minOut`; the properties
 * pinned here are the ones that lose money when wrong: phase routing (curve vs pool vs paused),
 * fee/snipe accounting, an explicit `minOut` above the quote being refused before gas is spent,
 * and the balance gates that run before any signing. The chain surface is injected; no I/O.
 */

vi.mock("@pyre/db", () => ({ prisma: {} }));
vi.mock("../src/lib/custodial.js", () => ({
  custodialAccount: () => ({ address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA" }),
  custodialEthBalance: vi.fn(),
  GAS_RESERVE_WEI: 20_000_000_000_000n,
  GAS_RESERVE_BY_CHAIN: { robinhood: 20_000_000_000_000n, solana: 2_000_000n },
}));
vi.mock("../src/lib/events.js", () => ({ publishEvent: vi.fn(), publishGlobal: vi.fn() }));

import { BPS, quoteBuy, quoteSell, type CurveState, type LaunchRecord } from "@pyre/chain";
import { TradeBody } from "@pyre/shared";
import { buildQuote, executeTrade, executeVenueTrade, quoteTrade, quoteVenueTrade, type TradeChain, type VenueTradeChain } from "../src/lib/trade.js";

const ETH = 10n ** 18n;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const CURVE = "0x4444444444444444444444444444444444444444" as Address;
const WALLET = "0x84F8E5a324466Deb7447048C014CF0245ce04afA" as Address;
const HASH = ("0x" + "cd".repeat(32)) as Hash;

const launch = (phase: LaunchRecord["phase"]): LaunchRecord => ({
  token: TOKEN,
  curve: CURVE,
  deployer: WALLET,
  creatorFeeRecipient: WALLET,
  pairToken: "0x0000000000000000000000000000000000000000",
  phase,
  graduationThresholdWei: 4_200n * ETH,
  poolFee: 0,
  tickSpacing: 60,
  poolId: ("0x" + "00".repeat(32)) as `0x${string}`,
  buybackEnabled: false,
  creatorTaxBps: 0,
  exists: true,
});

/** A fresh PONS curve: 1B tokens against ~1 ETH of pricing reserve, 1% fee, no creator tax. */
const curve = (snipeTaxBps = 0n): CurveState => ({
  quoteReserve: 1n * ETH,
  tokenReserve: 1_000_000_000n * ETH,
  sellableTokens: 800_000_000n * ETH,
  feeBps: 100n,
  creatorTaxBps: 0n,
  snipeTaxBps,
});

const app = { id: "app1", slug: "cool", chain: "robinhood" as const, launchpad: "pons_v2" as const, tokenAddress: TOKEN, curveAddress: CURVE, launchPhase: 0, status: "LIVE" as const, priceUsd: 0.000002 };

const chain = (over: Partial<TradeChain> = {}): TradeChain => ({
  readLaunch: async () => launch(0),
  readCurveState: async () => curve(),
  v4QuoteExactIn: async () => 0n,
  curveBuy: vi.fn(async (_a, _c, wei, _min) => ({ hash: HASH, tokensOut: quoteBuy(curve(), wei).tokensOut, refundWei: 0n })),
  curveSell: vi.fn(async (_a, _c, tokens) => ({ hash: HASH, quoteOut: quoteSell(curve(), tokens) })),
  v4SwapExactIn: vi.fn(async () => ({ hash: HASH, out: 0n })),
  ethBalance: async () => 10n * ETH,
  tokenBalance: async () => 1_000_000n * ETH,
  ethPriceUsd: async () => 2000,
  receiptBlock: async () => 12345n,
  ...over,
});

describe("buildQuote on the curve", () => {
  it("quotes a buy with the fee taken off the input and a 1% default slippage floor", () => {
    const state = curve();
    const q = buildQuote(app, { slug: "cool", side: "buy", amount: (ETH / 10n).toString(), slippageBps: 100 }, { launch: launch(0), ethPriceUsd: 2000, curve: state });
    const expected = quoteBuy(state, ETH / 10n);
    expect(q.venue).toBe("CURVE");
    expect(q.amountOut).toBe(expected.tokensOut.toString());
    expect(q.minOut).toBe(((expected.tokensOut * (BPS - 100n)) / BPS).toString());
    // 1% fee on 0.1 ETH.
    expect(q.feeWei).toBe((ETH / 1000n).toString());
    expect(q.snipeTaxBps).toBe(0);
    expect(q.refundWei).toBe("0");
    expect(q.priceImpactPct).toBeGreaterThan(0);
    // Execution price ≈ 0.1 ETH / tokensOut × $2000.
    expect(q.priceUsd).toBeCloseTo((Number(ETH / 10n) / Number(expected.tokensOut)) * 2000, 12);
  });

  it("reports the snipe tax and charges it on top of the base fee", () => {
    const state = curve(500n);
    const q = buildQuote(app, { slug: "cool", side: "buy", amount: ETH.toString(), slippageBps: 100 }, { launch: launch(0), ethPriceUsd: 2000, curve: state });
    expect(q.snipeTaxBps).toBe(500);
    expect(q.feeWei).toBe(((ETH * 600n) / BPS).toString());
    expect(BigInt(q.amountOut)).toBeLessThan(quoteBuy(curve(), ETH).tokensOut);
  });

  it("quotes a sell with fees off the output and negative impact", () => {
    const state = curve();
    const tokens = 1_000_000n * ETH;
    const q = buildQuote(app, { slug: "cool", side: "sell", amount: tokens.toString(), slippageBps: 50 }, { launch: launch(0), ethPriceUsd: 2000, curve: state });
    const out = quoteSell(state, tokens);
    expect(q.amountOut).toBe(out.toString());
    expect(q.minOut).toBe(((out * (BPS - 50n)) / BPS).toString());
    const gross = (tokens * state.quoteReserve) / (state.tokenReserve + tokens);
    expect(q.feeWei).toBe((gross - out).toString());
    expect(q.priceImpactPct).toBeLessThan(0);
  });

  it("surfaces the refund when a buy overshoots the sellable allocation", () => {
    const state = { ...curve(), sellableTokens: 1_000n * ETH };
    const q = buildQuote(app, { slug: "cool", side: "buy", amount: ETH.toString(), slippageBps: 100 }, { launch: launch(0), ethPriceUsd: 2000, curve: state });
    expect(q.amountOut).toBe((1_000n * ETH).toString());
    expect(BigInt(q.refundWei)).toBeGreaterThan(0n);
  });

  it("honours an explicit minOut and rejects one the quote cannot meet, before any transaction", () => {
    const state = curve();
    const expected = quoteBuy(state, ETH / 10n);
    const floor = expected.tokensOut - 1n;
    const ok = buildQuote(app, { slug: "cool", side: "buy", amount: (ETH / 10n).toString(), minOut: floor.toString(), slippageBps: 100 }, { launch: launch(0), ethPriceUsd: 2000, curve: state });
    expect(ok.minOut).toBe(floor.toString());
    expect(() =>
      buildQuote(app, { slug: "cool", side: "buy", amount: (ETH / 10n).toString(), minOut: (expected.tokensOut + 1n).toString(), slippageBps: 100 }, { launch: launch(0), ethPriceUsd: 2000, curve: state }),
    ).toThrow(expect.objectContaining({ status: 400, message: "slippage_exceeded" }));
  });

  it("never accepts an explicit minOut below the 50% slippage ceiling, and the schema refuses negative amounts", () => {
    const state = curve();
    const expected = quoteBuy(state, ETH / 10n);
    const halve = (expected.tokensOut * (BPS - 5000n)) / BPS;
    const quoteWith = (minOut: bigint) =>
      buildQuote(app, { slug: "cool", side: "buy", amount: (ETH / 10n).toString(), minOut: minOut.toString(), slippageBps: 100 }, { launch: launch(0), ethPriceUsd: 2000, curve: state });
    expect(quoteWith(halve).minOut).toBe(halve.toString());
    for (const minOut of [halve - 1n, 1n, 0n]) {
      expect(() => quoteWith(minOut)).toThrow(expect.objectContaining({ status: 400, message: "min_out_too_low", extra: expect.objectContaining({ floor: halve.toString() }) }));
    }
    expect(TradeBody.safeParse({ slug: "cool", side: "buy", amount: "1", minOut: "-1" }).success).toBe(false);
    expect(TradeBody.safeParse({ slug: "cool", side: "buy", amount: "-1" }).success).toBe(false);
  });

  it("rejects non-positive amounts", () => {
    expect(() => buildQuote(app, { slug: "cool", side: "buy", amount: "0", slippageBps: 100 }, { launch: launch(0), ethPriceUsd: 2000, curve: curve() })).toThrow(
      expect.objectContaining({ message: "invalid_amount" }),
    );
  });
});

describe("phase routing", () => {
  it("quotes graduated coins through the v4 quoter with the hook fee on the ETH leg", async () => {
    const c = chain({ readLaunch: async () => launch(2), v4QuoteExactIn: vi.fn(async () => 5_000n * ETH) });
    const { quote } = await quoteTrade({ ...app, launchPhase: 2 }, WALLET, { slug: "cool", side: "buy", amount: ETH.toString(), slippageBps: 200 }, c);
    expect(quote.venue).toBe("POOL");
    expect(quote.amountOut).toBe((5_000n * ETH).toString());
    expect(quote.feeWei).toBe((ETH / 100n).toString());
    expect(quote.minOut).toBe(((5_000n * ETH * 9800n) / BPS).toString());
    expect(c.v4QuoteExactIn).toHaveBeenCalledWith(expect.objectContaining({ phase: 2 }), { ethIn: ETH });
  });

  it("refuses to trade while the launch is between curve and pool (phase 1/3)", async () => {
    await expect(quoteTrade(app, WALLET, { slug: "cool", side: "buy", amount: ETH.toString(), slippageBps: 100 }, chain({ readLaunch: async () => launch(1) }))).rejects.toMatchObject({
      status: 409,
      message: "trading_paused",
    });
  });

  it("refuses an app whose token the factory does not know", async () => {
    await expect(
      quoteTrade(app, WALLET, { slug: "cool", side: "buy", amount: ETH.toString(), slippageBps: 100 }, chain({ readLaunch: async () => ({ ...launch(0), exists: false }) })),
    ).rejects.toMatchObject({ status: 409, message: "app_not_launched" });
  });
});

describe("executeTrade", () => {
  const user = { id: "u1", wallet: WALLET, walletIndex: 5 };

  it("sends the curve buy with the quote's minOut from the custodial account and records the fill", async () => {
    const curveBuy = vi.fn(async (_a: unknown, _c: Address, wei: bigint, _min: bigint, _r: Address) => ({ hash: HASH, tokensOut: quoteBuy(curve(), wei).tokensOut, refundWei: 0n }));
    const c = chain({ curveBuy });
    const { quote, trade } = await executeTrade(app, user, { slug: "cool", side: "buy", amount: (ETH / 10n).toString(), slippageBps: 100 }, c);
    expect(curveBuy).toHaveBeenCalledTimes(1);
    const [account, curveAddr, wei, minOut, recipient] = curveBuy.mock.calls[0]!;
    expect(account).toMatchObject({ address: WALLET });
    expect(curveAddr).toBe(CURVE);
    expect(wei).toBe(ETH / 10n);
    expect(minOut).toBe(BigInt(quote.minOut));
    expect(recipient).toBe(WALLET);
    expect(trade).toMatchObject({ txHash: HASH, block: 12345n, quoteWei: ETH / 10n, tokenUnits: BigInt(quote.amountOut) });
    expect(trade.priceUsd).toBeCloseTo(quote.priceUsd, 12);
  });

  it("blocks a buy the wallet cannot fund (amount + gas reserve) before signing", async () => {
    const c = chain({ ethBalance: async () => ETH / 10n });
    await expect(executeTrade(app, user, { slug: "cool", side: "buy", amount: (ETH / 10n).toString(), slippageBps: 100 }, c)).rejects.toMatchObject({
      status: 400,
      message: "insufficient_balance",
    });
    expect(c.curveBuy).not.toHaveBeenCalled();
  });

  it("blocks a sell of more tokens than the wallet holds, and a sell without gas", async () => {
    const short = chain({ tokenBalance: async () => 10n * ETH });
    await expect(executeTrade(app, user, { slug: "cool", side: "sell", amount: (11n * ETH).toString(), slippageBps: 100 }, short)).rejects.toMatchObject({ message: "insufficient_balance" });
    const noGas = chain({ ethBalance: async () => 0n });
    await expect(executeTrade(app, user, { slug: "cool", side: "sell", amount: ETH.toString(), slippageBps: 100 }, noGas)).rejects.toMatchObject({ message: "insufficient_gas" });
    expect(short.curveSell).not.toHaveBeenCalled();
    expect(noGas.curveSell).not.toHaveBeenCalled();
  });

  it("maps an on-chain revert to 502 trade_failed", async () => {
    const c = chain({ curveBuy: vi.fn(async () => Promise.reject(new Error("execution reverted: SlippageExceeded"))) });
    await expect(executeTrade(app, user, { slug: "cool", side: "buy", amount: ETH.toString(), slippageBps: 100 }, c)).rejects.toMatchObject({
      status: 502,
      message: "trade_failed",
      extra: { reason: "execution reverted: SlippageExceeded" },
    });
  });
});

/* ─────────────────────────── pump.fun (generic venue path) ─────────────────────────── */

const SOL = 10n ** 9n;
const UNIT = 10n ** 6n;
const MINT = "7LSsdY1uSQ2eR1vUSp7cw2jxBkm4bkkPrzHhrFeNpump";
const SOL_WALLET = "So1anaUser111111111111111111111111111111111";
const SIG = "5wHu1qwD4E3vTd9nJqvUeYtWuDL1yiLFJVXDQzVdYc3PtLHRZAx9y1n2Cz3wVn3nS4eZfLPaJRBk6eZB4bHzAYS";
const pumpApp = { ...app, id: "app2", slug: "solcool", chain: "solana" as const, launchpad: "pump_fun" as const, tokenAddress: MINT, curveAddress: "CurveAddr111111111111111111111111111111111", priceUsd: 0.00003 };

/** A pump curve quoting 1M coins per 0.1 SOL with the 1.25% launchpad fee (0.95 protocol + 0.30 creator). */
const pump = (over: Partial<VenueTradeChain> = {}, phase: 0 | 1 | 2 = 0): VenueTradeChain & { buy: Mock; sell: Mock; quoteBuy: Mock } => ({
  info: { chain: "solana", launchpad: "pump_fun", native: { symbol: "SOL", decimals: 9 }, tokenDecimals: 6, totalSupplyUnits: 10n ** 15n, chainLabel: "Solana", launchpadLabel: "pump.fun", explorerTxUrl: (t) => t, explorerAddressUrl: (a) => a, explorerTokenUrl: (t) => t, launchpadUrl: (t) => t },
  readLaunch: async () => ({ exists: true, token: MINT, curve: pumpApp.curveAddress, pool: phase === 2 ? "Poo1111111111111111111111111111111111111111" : null, phase, progress: 0.1, raisedNative: 8n * SOL, graduationNative: 85n * SOL, priceNative: 1e-7, totalSupplyUnits: 10n ** 15n, circulatingUnits: 10n ** 14n, burnedUnits: 0n }),
  quoteBuy: vi.fn(async (_t: string, spend: bigint) => ({ native: spend, tokenUnits: (spend * 10_000_000n * UNIT) / SOL, priceNative: 1e-7, feeBps: 125, impact: 0.004 })),
  quoteSell: vi.fn(async (_t: string, units: bigint) => ({ native: (units * SOL) / (10_000_000n * UNIT), tokenUnits: units, priceNative: 1e-7, feeBps: 125, impact: 0.004 })),
  buy: vi.fn(async (_a, _t, spend: bigint) => ({ hash: SIG, block: 300_000_001, tokenUnits: (spend * 10_000_000n * UNIT) / SOL, spentNative: spend })),
  sell: vi.fn(async (_a, _t, units: bigint) => ({ hash: SIG, block: 300_000_002, receivedNative: (units * SOL) / (10_000_000n * UNIT) })),
  nativeBalance: async () => 5n * SOL,
  tokenBalance: async () => 50_000_000n * UNIT,
  nativePriceUsd: async () => 120,
  userWallet: () => ({ chain: "solana", address: SOL_WALLET, signer: {} }),
  ...over,
});

describe("quoteVenueTrade (pump.fun)", () => {
  it("quotes a curve buy from the adapter math in lamports/6-decimal units with the launchpad fee and a 1% floor", async () => {
    const c = pump();
    const q = await quoteVenueTrade(pumpApp, { slug: "solcool", side: "buy", amount: (SOL / 10n).toString(), slippageBps: 100 }, SOL_WALLET, c);
    expect(q).toMatchObject({ venue: "CURVE", phase: 0, chain: "solana", native: { symbol: "SOL", decimals: 9 }, snipeTaxBps: 0, refundWei: "0", nativePriceUsd: 120 });
    expect(q.amountOut).toBe((1_000_000n * UNIT).toString());
    expect(q.minOut).toBe(((1_000_000n * UNIT * 9900n) / BPS).toString());
    // 1.25% of 0.1 SOL.
    expect(q.feeWei).toBe(((SOL / 10n) * 125n) / BPS + "");
    expect(q.priceImpactPct).toBeCloseTo(0.4, 9);
    expect(q.priceUsd).toBeCloseTo(1e-7 * 120, 12);
    expect(c.quoteBuy).toHaveBeenCalledWith(MINT, SOL / 10n, SOL_WALLET);
  });

  it("routes a graduated coin to the pool and pauses while migrating", async () => {
    const graduated = await quoteVenueTrade({ ...pumpApp, launchPhase: 2 }, { slug: "solcool", side: "sell", amount: (1_000_000n * UNIT).toString(), slippageBps: 100 }, SOL_WALLET, pump({}, 2));
    expect(graduated.venue).toBe("POOL");
    expect(graduated.amountOut).toBe((SOL / 10n).toString());
    await expect(quoteVenueTrade(pumpApp, { slug: "solcool", side: "buy", amount: SOL.toString(), slippageBps: 100 }, SOL_WALLET, pump({}, 1))).rejects.toMatchObject({ status: 409, message: "trading_paused" });
  });

  it("never accepts an explicit floor looser than 50% slippage", async () => {
    await expect(
      quoteVenueTrade(pumpApp, { slug: "solcool", side: "buy", amount: (SOL / 10n).toString(), minOut: "1", slippageBps: 100 }, SOL_WALLET, pump()),
    ).rejects.toMatchObject({ status: 400, message: "min_out_too_low" });
  });
});

describe("executeVenueTrade (pump.fun)", () => {
  const user = { id: "u1", wallet: WALLET, walletIndex: 5 };

  it("buys from the custodial Solana wallet with the quote's minOut and reports the fill in lamports", async () => {
    const c = pump();
    const { quote, trade } = await executeVenueTrade(pumpApp, user, { slug: "solcool", side: "buy", amount: (SOL / 10n).toString(), slippageBps: 100 }, c);
    expect(c.buy).toHaveBeenCalledTimes(1);
    const [account, mint, spend, minOut] = c.buy.mock.calls[0]!;
    expect(account).toMatchObject({ chain: "solana", address: SOL_WALLET });
    expect(mint).toBe(MINT);
    expect(spend).toBe(SOL / 10n);
    expect(minOut).toBe(BigInt(quote.minOut));
    expect(trade).toMatchObject({ txHash: SIG, block: 300_000_001n, wallet: SOL_WALLET, quoteWei: SOL / 10n, tokenUnits: 1_000_000n * UNIT });
    // 0.1 SOL for 1M coins = 1e-7 SOL/coin at $120: the price must respect 9 vs 6 decimals.
    expect(trade.priceUsd).toBeCloseTo(1e-7 * 120, 12);
  });

  it("keeps the rent reserve on a buy and blocks a sell without it or without the coins", async () => {
    const tight = pump({ nativeBalance: async () => SOL / 10n });
    await expect(executeVenueTrade(pumpApp, user, { slug: "solcool", side: "buy", amount: (SOL / 10n).toString(), slippageBps: 100 }, tight)).rejects.toMatchObject({ message: "insufficient_balance", extra: { asset: "SOL" } });
    expect(tight.buy).not.toHaveBeenCalled();
    const noGas = pump({ nativeBalance: async () => 0n });
    await expect(executeVenueTrade(pumpApp, user, { slug: "solcool", side: "sell", amount: UNIT.toString(), slippageBps: 100 }, noGas)).rejects.toMatchObject({ message: "insufficient_gas" });
    const short = pump({ tokenBalance: async () => UNIT });
    await expect(executeVenueTrade(pumpApp, user, { slug: "solcool", side: "sell", amount: (2n * UNIT).toString(), slippageBps: 100 }, short)).rejects.toMatchObject({ message: "insufficient_balance", extra: { asset: "TOKEN" } });
    expect(short.sell).not.toHaveBeenCalled();
  });

  it("maps a failed send to 502 trade_failed", async () => {
    const c = pump({ buy: vi.fn(async () => Promise.reject(new Error("Transaction simulation failed: custom program error: 0x1772"))) });
    await expect(executeVenueTrade(pumpApp, user, { slug: "solcool", side: "buy", amount: SOL.toString(), slippageBps: 100 }, c)).rejects.toMatchObject({ status: 502, message: "trade_failed" });
  });
});
