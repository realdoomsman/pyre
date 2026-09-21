import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { computePoolId, poolKey, priceFromSqrtPriceX96 } from "./read.js";

const MEME_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
// EQUITY, a graduated PONS v2 launch; its pool id is listed by GeckoTerminal (dex pons-v2-dex)
// and `hook.launches(poolId).registered` is true on-chain.
const EQUITY = "0x00ca30AAD368e1cd5DD9736b2C2dB1101F30B8D8";
const EQUITY_POOL_ID = "0xf6b8694ff537fa7d453a3d6abda8d211d1de3db067c66d0936fc292561e47e9e";

describe("v4 pool id", () => {
  it("puts native ETH in currency0 and reproduces the documented pool id", () => {
    const key = poolKey(EQUITY, zeroAddress, 0, 200, MEME_HOOK);
    expect(key.currency0).toBe(zeroAddress);
    expect(key.currency1).toBe(EQUITY);
    expect(computePoolId(key)).toBe(EQUITY_POOL_ID);
  });

  it("sorts an ERC-20 pair by address", () => {
    const low = "0x0000000000000000000000000000000000000001";
    const key = poolKey(EQUITY, low, 0, 200, MEME_HOOK);
    expect(key.currency0).toBe(low);
    expect(computePoolId(key)).not.toBe(EQUITY_POOL_ID);
  });
});

describe("price from sqrtPriceX96", () => {
  it("orients by which side the token is on", () => {
    const one = 2n ** 96n;
    expect(priceFromSqrtPriceX96(one, true)).toBe(1);
    expect(priceFromSqrtPriceX96(one, false)).toBe(1);
    const two = 2n ** 97n; // ratio 4 currency1 per currency0
    expect(priceFromSqrtPriceX96(two, true)).toBe(4);
    expect(priceFromSqrtPriceX96(two, false)).toBe(0.25);
    expect(priceFromSqrtPriceX96(0n, false)).toBe(0);
  });
});
