import { describe, expect, it } from "vitest";
import { quoteBuy, quoteSell, type CurveState } from "./curve.js";

/*
 * Vectors hand-computed from the curve's documented integer arithmetic
 * (https://docs.ponsfamily.com/v2 "Getting a quote"). A quote that drifts from the contract by
 * one wei makes `minTokensOut` revert real trades, so these pin the exact rounding.
 */
const base: CurveState = { quoteReserve: 1000n, tokenReserve: 10_000n, sellableTokens: 5000n, feeBps: 100n, creatorTaxBps: 200n, snipeTaxBps: 0n };

describe("curve buy quote", () => {
  it("takes fee and tax off the input before pricing", () => {
    // fee 1, tax 2 → 97 net → 97 × 10000 / (1000 + 97) = 884.23 → 884
    expect(quoteBuy(base, 100n)).toEqual({ tokensOut: 884n, spent: 100n, refund: 0n });
  });

  it("clamps to sellableTokens and reprices the input from the token side", () => {
    // 97000 net would buy 9603 > 5000 sellable; amountIn(5000) = 5000×1000/5000 + 1 = 1001;
    // grossed up by 1/(1 − 0.03) with ceil → 1032; the rest is refunded.
    expect(quoteBuy(base, 100_000n)).toEqual({ tokensOut: 5000n, spent: 1032n, refund: 98_968n });
  });

  it("caps the snipe tax so the buyer nets at least 1%", () => {
    // raw 9900 bps capped to 10000 − 100 − 200 − 100 = 9600 → 100 net of 10000 → 909
    expect(quoteBuy({ ...base, snipeTaxBps: 9900n }, 10_000n).tokensOut).toBe(909n);
  });

  it("matches the live launch config at 1 ETH on a fresh curve", () => {
    const fresh: CurveState = {
      quoteReserve: 1_680_000_000_000_000_000n,
      tokenReserve: 10n ** 27n,
      sellableTokens: 10n ** 27n - 285_714_285_714_285_714_285_714_285n,
      feeBps: 100n,
      creatorTaxBps: 0n,
      snipeTaxBps: 0n,
    };
    expect(quoteBuy(fresh, 10n ** 18n)).toEqual({ tokensOut: 370_786_516_853_932_584_269_662_921n, spent: 10n ** 18n, refund: 0n });
  });
});

describe("curve sell quote", () => {
  it("prices first, then takes fee and tax off the output", () => {
    // gross = 1000 × 1000 / 11000 = 90; fee 0, tax 1 → 89
    expect(quoteSell(base, 1000n)).toBe(89n);
  });
});
