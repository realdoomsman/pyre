import { describe, expect, it, vi } from "vitest";
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
}));
vi.mock("../src/lib/events.js", () => ({ publishEvent: vi.fn(), publishGlobal: vi.fn() }));

import { BPS, quoteBuy, quoteSell, type CurveState, type LaunchRecord } from "@pyre/chain";
import { buildQuote, executeTrade, quoteTrade, type TradeChain } from "../src/lib/trade.js";

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

const app = { id: "app1", slug: "cool", tokenAddress: TOKEN, curveAddress: CURVE, launchPhase: 0, status: "LIVE" as const, priceUsd: 0.000002 };

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
