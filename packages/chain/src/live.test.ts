import { parseEther, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { PUBLIC_RPC_URL, publicClient } from "./chain.js";
import { deriveWallet } from "./keys.js";
import { factoryAbi, hookAbi, usdgAbi } from "./pons/abi.js";
import { ponsAddresses } from "./pons/addresses.js";
import { curveQuoteBuy } from "./pons/curve.js";
import { accruingFees, getPrice, getTokenInfo, readLaunch } from "./pons/read.js";
import { v4QuoteExactIn } from "./pons/v4.js";
import { usdgAddress } from "./transfer.js";
import { buildCandlesFromTrades, getTrades } from "./candles.js";

/*
 * Read-only checks against the live chain. Opt in with CHAIN_LIVE_TESTS=1; the default suite stays
 * offline. Nothing here signs or sends.
 */
const LIVE = process.env.CHAIN_LIVE_TESTS === "1";
// The root vitest env pins every external endpoint to an unroutable host so nothing touches the
// network by accident; a live run needs the real ones (override RPC with CHAIN_LIVE_RPC_URL).
if (LIVE) {
  process.env.RPC_URL = process.env.CHAIN_LIVE_RPC_URL ?? PUBLIC_RPC_URL;
  delete process.env.BLOCKSCOUT_URL;
}
const SEED = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
// Graduated PONS v2 launch (EQUITY) and a recent curve-phase launch, both from the research notes.
const EQUITY = "0x00ca30AAD368e1cd5DD9736b2C2dB1101F30B8D8";
const EQUITY_POOL_ID = "0xf6b8694ff537fa7d453a3d6abda8d211d1de3db067c66d0936fc292561e47e9e";
const BUL = "0x69C70006c20914435560F62220F867B71003785f";

describe.skipIf(!LIVE)("live Robinhood Chain (CHAIN_LIVE_TESTS=1)", () => {
  const client = publicClient();
  const { factory, memeHook } = ponsAddresses();

  it("factory: launchFee is 0.0005 ETH and the treasury may launch", async () => {
    const [fee, allowed] = await Promise.all([
      client.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }),
      client.readContract({ address: factory, abi: factoryAbi, functionName: "canLaunch", args: [deriveWallet(0, SEED).address] }),
    ]);
    expect(fee).toBe(parseEther("0.0005"));
    expect(allowed).toBe(true);
  });

  it("readLaunch: graduated launch has phase 2 and the documented pool id", async () => {
    const launch = await readLaunch(EQUITY);
    expect(launch.exists).toBe(true);
    expect(launch.phase).toBe(2);
    expect(launch.pairToken).toBe(zeroAddress);
    expect(launch.poolId).toBe(EQUITY_POOL_ID);
    const pool = await client.readContract({ address: memeHook, abi: hookAbi, functionName: "launches", args: [launch.poolId] });
    expect(pool[0]).toBe(true); // registered
    expect(pool[2]).toBe(EQUITY); // memecoin
    const price = await getPrice(launch);
    expect(price.priceEth).toBeGreaterThan(0);
    expect(price.priceUsd).toBeGreaterThan(0);
    expect(price.progress).toBe(1);
    expect(price.totalSupply).toBeGreaterThan(0n);
    const quote = await v4QuoteExactIn(launch, { ethIn: parseEther("0.001") });
    expect(quote).toBeGreaterThan(0n);
    // A 0.001 ETH buy lands within 5% of spot (1% hook fee + pool depth).
    expect(Number(quote) / 1e18).toBeGreaterThan((0.001 / price.priceEth) * 0.95);
    const fees = await accruingFees(launch);
    expect(fees.unsweptWei).toBeGreaterThanOrEqual(0n);
    expect(fees.escrowWei).toBeGreaterThanOrEqual(0n);
  });

  it("readLaunch + curve quote on a v2 launch, token info and unknown token", async () => {
    const launch = await readLaunch(BUL);
    expect(launch.exists).toBe(true);
    expect(launch.curve).not.toBe(zeroAddress);
    const info = await getTokenInfo(BUL);
    expect(info.symbol.length).toBeGreaterThan(0);
    expect(info.decimals).toBe(18);
    expect(info.burnedUnits).toBeGreaterThanOrEqual(0n);
    if (launch.phase === 0) {
      const quote = await curveQuoteBuy(launch.curve, parseEther("0.01"), deriveWallet(0, SEED).address);
      expect(quote.tokensOut).toBeGreaterThan(0n);
      expect(quote.spent + quote.refund).toBe(parseEther("0.01"));
    }
    const unknown = await readLaunch("0x0000000000000000000000000000000000000001");
    expect(unknown.exists).toBe(false);
  });

  it("USDG DOMAIN_SEPARATOR matches the EIP-712 domain we sign with", async () => {
    const onChain = await client.readContract({ address: usdgAddress(), abi: usdgAbi, functionName: "DOMAIN_SEPARATOR" });
    expect(onChain).toBe("0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036");
  });

  it("trades resolve for the graduated pool and fold into candles", async () => {
    const launch = await readLaunch(EQUITY);
    const latest = await client.getBlockNumber();
    const trades = await getTrades(launch, latest - 5_000n, latest);
    for (const t of trades) {
      expect(t.priceEth).toBeGreaterThan(0);
      expect(["buy", "sell"]).toContain(t.side);
    }
    const candles = buildCandlesFromTrades(trades, "1h", 1);
    for (let i = 1; i < candles.length; i++) expect(candles[i - 1]!.t).toBeLessThan(candles[i]!.t);
  });
});
