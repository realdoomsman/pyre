import { readFileSync } from "node:fs";
import { decodeFunctionData, toFunctionSelector, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  computePoolId,
  curveAbi,
  encodeCurveBuy,
  encodeCurveSell,
  encodeV4Swap,
  launchPoolKey,
  PONS_ADDRESSES,
  quoteBuy,
  universalRouterAbi,
  withSlippage,
  type CurveState,
  type LaunchRecord,
} from "./browser.js";

const CURVE = "0x2d0D28866eA43d5Bf92c62E081327FB1dBEaBC3E";
const TOKEN = "0x00ca30AAD368e1cd5DD9736b2C2dB1101F30B8D8";
const BUYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("browser entry stays browser-safe", () => {
  it("imports nothing from env, node builtins or the client modules", () => {
    const source = readFileSync(new URL("./browser.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.every((spec) => spec === "viem" || spec === "./pons/abi.js")).toBe(true);
    expect(source).not.toMatch(/process\.env/);
  });
});

describe("external-wallet curve trade encoding", () => {
  const state: CurveState = {
    quoteReserve: 1_680_000_000_000_000_000n,
    tokenReserve: 10n ** 27n,
    sellableTokens: 10n ** 27n - 285_714_285_714_285_714_285_714_285n,
    feeBps: 100n,
    creatorTaxBps: 0n,
    snipeTaxBps: 0n,
  };

  it("encodes curve.buy(quoteIn, minTokensOut, recipient) with value = quoteIn", () => {
    const wei = 10n ** 17n;
    const { tokensOut } = quoteBuy(state, wei);
    const minOut = withSlippage(tokensOut, 100);
    const tx = encodeCurveBuy(CURVE, wei, minOut, BUYER);
    expect(tx.to).toBe(CURVE);
    expect(tx.value).toBe(wei);
    expect(tx.data.slice(0, 10)).toBe(toFunctionSelector("buy(uint256,uint256,address)"));
    const decoded = decodeFunctionData({ abi: curveAbi, data: tx.data });
    expect(decoded.functionName).toBe("buy");
    expect(decoded.args).toEqual([wei, minOut, BUYER]);
    expect(minOut).toBe((tokensOut * 9_900n) / 10_000n);
  });

  it("encodes curve.sell(tokensIn, minQuoteOut, recipient) with no value", () => {
    const tx = encodeCurveSell(CURVE, 5n * 10n ** 18n, 1_000n, BUYER);
    expect(tx.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: curveAbi, data: tx.data });
    expect(decoded.functionName).toBe("sell");
    expect(decoded.args).toEqual([5n * 10n ** 18n, 1_000n, BUYER]);
  });

  it("rejects non-positive amounts before touching a wallet", () => {
    expect(() => encodeCurveBuy(CURVE, 0n, 0n, BUYER)).toThrow(/positive/);
    expect(() => encodeCurveSell(CURVE, 0n, 0n, BUYER)).toThrow(/positive/);
  });
});

describe("external-wallet v4 swap encoding", () => {
  const launch: LaunchRecord = {
    token: TOKEN,
    curve: CURVE,
    deployer: BUYER,
    creatorFeeRecipient: BUYER,
    pairToken: zeroAddress,
    phase: 2,
    graduationThresholdWei: 4_200_000_000_000_000_000n,
    poolFee: 0,
    tickSpacing: 200,
    poolId: "0x",
    buybackEnabled: false,
    creatorTaxBps: 0,
    exists: true,
  };
  launch.poolId = computePoolId(launchPoolKey(launch));

  it("targets the Universal Router with execute(commands, inputs, deadline) and ETH as value", () => {
    const tx = encodeV4Swap(launch, { ethIn: 10n ** 16n }, 1n, BUYER, BUYER, 1_800_000_000n);
    expect(tx.to).toBe(PONS_ADDRESSES.universalRouter);
    expect(tx.value).toBe(10n ** 16n);
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data: tx.data });
    expect(decoded.functionName).toBe("execute");
    expect(decoded.args?.[0]).toBe("0x10");
    expect(decoded.args?.[2]).toBe(1_800_000_000n);
  });

  it("sends no ETH on a token→ETH swap", () => {
    expect(encodeV4Swap(launch, { tokensIn: 5n }, 1n, BUYER, BUYER, 1n).value).toBe(0n);
  });
});
