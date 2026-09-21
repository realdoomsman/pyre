import { describe, expect, it } from "vitest";
import { buildCandlesFromTrades, type Trade } from "./candles.js";

const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function trade(ts: number, priceEth: number, quoteEth: number, side: "buy" | "sell" = "buy"): Trade {
  const quoteWei = BigInt(Math.round(quoteEth * 1e6)) * 10n ** 12n;
  const tokenUnits = BigInt(Math.round((quoteEth / priceEth) * 1e6)) * 10n ** 12n;
  return { hash: `0x${ts.toString(16).padStart(64, "0")}`, block: ts, ts, side, wallet: WALLET, tokenUnits, quoteWei, priceEth };
}

describe("buildCandlesFromTrades", () => {
  it("buckets by interval, tracks OHLC in USD and sums quote volume", () => {
    const ethUsd = 2000;
    const trades = [trade(3_600 * 10 + 5, 0.001, 1), trade(3_600 * 10 + 60, 0.002, 2, "sell"), trade(3_600 * 10 + 3_599, 0.0015, 0.5), trade(3_600 * 11 + 1, 0.003, 1)];
    const candles = buildCandlesFromTrades(trades, "1h", ethUsd);
    expect(candles).toEqual([
      { t: 36_000, o: 2, h: 4, l: 2, c: 3, v: 7000 },
      { t: 39_600, o: 6, h: 6, l: 6, c: 6, v: 2000 },
    ]);
  });

  it("sorts unordered trades and skips zero-token rows", () => {
    const later = trade(120, 0.002, 1);
    const earlier = trade(60, 0.001, 1);
    const empty: Trade = { ...trade(90, 0.001, 1), tokenUnits: 0n };
    const candles = buildCandlesFromTrades([later, empty, earlier], "1m", 1);
    expect(candles.map((c) => c.t)).toEqual([60, 120]);
    expect(candles[0]?.c).toBe(0.001);
  });

  it("returns nothing for no trades", () => {
    expect(buildCandlesFromTrades([], "5m", 1)).toEqual([]);
  });
});
