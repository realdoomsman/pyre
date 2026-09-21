import { decodeAbiParameters, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { LaunchRecord } from "./read.js";
import { computePoolId, launchPoolKey } from "./read.js";
import { encodeV4ExactInSingle, exactInputSingleParamsAbi } from "./v4.js";

const EQUITY = "0x00ca30AAD368e1cd5DD9736b2C2dB1101F30B8D8";
const SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const launch: LaunchRecord = {
  token: EQUITY,
  curve: "0x2d0D28866eA43d5Bf92c62E081327FB1dBEaBC3E",
  deployer: OTHER,
  creatorFeeRecipient: OTHER,
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

const actionsAndParams = (input: `0x${string}`) => decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], input);

describe("Universal Router v4 encoding", () => {
  it("encodes ETH→token as V4_SWAP / SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL to self", () => {
    const { commands, inputs } = encodeV4ExactInSingle(launch, { ethIn: 10n ** 15n }, 5n, SENDER, SENDER);
    expect(commands).toBe("0x10");
    const [actions, params] = actionsAndParams(inputs[0]!);
    expect(actions).toBe("0x060c0f");
    const [settleCurrency, settleMax] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]!);
    expect(settleCurrency).toBe(zeroAddress);
    expect(settleMax).toBe(10n ** 15n);
    const [takeCurrency, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]!);
    expect(takeCurrency).toBe(EQUITY);
    expect(takeMin).toBe(5n);
    const [swap] = decodeAbiParameters(exactInputSingleParamsAbi, params[0]!);
    expect(swap.zeroForOne).toBe(true); // ETH is currency0 on an ETH pair
    expect(swap.amountIn).toBe(10n ** 15n);
    expect(swap.amountOutMinimum).toBe(5n);
    expect(swap.poolKey).toEqual({ currency0: zeroAddress, currency1: EQUITY, fee: 0, tickSpacing: 200, hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" });
  });

  it("encodes token→ETH with TAKE to an explicit recipient and the opposite direction", () => {
    const { inputs } = encodeV4ExactInSingle(launch, { tokensIn: 123n }, 1n, SENDER, OTHER);
    const [actions, params] = actionsAndParams(inputs[0]!);
    expect(actions).toBe("0x060c0e");
    const [takeCurrency, recipient, amount] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], params[2]!);
    expect(takeCurrency).toBe(zeroAddress);
    expect(recipient).toBe(OTHER);
    expect(amount).toBe(0n); // OPEN_DELTA: take everything the swap credited
    const [settleCurrency] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]!);
    expect(settleCurrency).toBe(EQUITY);
    expect(decodeAbiParameters(exactInputSingleParamsAbi, params[0]!)[0].zeroForOne).toBe(false);
  });

  it("refuses launches that are not on the pool yet", () => {
    expect(() => encodeV4ExactInSingle({ ...launch, phase: 0 }, { ethIn: 1n }, 0n, SENDER, SENDER)).toThrow(/phase 0/);
    expect(() => encodeV4ExactInSingle(launch, { ethIn: 0n }, 0n, SENDER, SENDER)).toThrow(/positive/);
  });
});
