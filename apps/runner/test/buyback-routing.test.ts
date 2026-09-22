import type * as Db from "@pyre/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The $PYRE buyback spends treasury ETH on whichever venue the launch trades on. Routing by the
 * factory's phase is what keeps a post-graduation buy off a closed curve (revert, ETH stuck in
 * a SWAPPING row) and a pre-graduation buy off a pool that does not exist yet. The slippage
 * bound and the refund accounting are what make the ledger's `ethWei` true.
 */

const TREASURY = "0x00000000000000000000000000000000000000AA";
const CURVE = "0x00000000000000000000000000000000000000c0";
const TOKEN = "0x1111111111111111111111111111111111111111";
const curveQuoteBuy = vi.fn();
const curveBuy = vi.fn();
const v4QuoteExactIn = vi.fn();
const v4SwapExactIn = vi.fn();

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma: {} }));
vi.mock("@pyre/chain", () => ({
  curveQuoteBuy,
  curveBuy,
  v4QuoteExactIn,
  v4SwapExactIn,
  treasury: () => ({ address: TREASURY, account: { address: TREASURY } }),
  attestationHash: () => "0x00",
  attestBurn: vi.fn(),
  burnTokens: vi.fn(),
  getErc20Balance: vi.fn(),
  getEthBalance: vi.fn(),
  getEthPriceUsd: vi.fn(),
  publicClient: () => ({ readContract: vi.fn() }),
  readLaunch: vi.fn(),
  tokenAbi: [],
}));
vi.mock("../src/workers/chain/env.js", () => ({ chainWorkerEnv: () => ({}) }));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/lock.js", () => ({ withLock: vi.fn() }));

// Dynamic import: the module binds `@pyre/chain` at load time, so it must come after the mocks.
const { buyTokens } = await import("../src/workers/chain/buyback.js");

const launch = (phase: 0 | 1 | 2 | 3) => ({
  token: TOKEN,
  curve: CURVE,
  deployer: TREASURY,
  creatorFeeRecipient: TREASURY,
  pairToken: "0x0000000000000000000000000000000000000000",
  phase,
  graduationThresholdWei: 4_200_000_000_000_000_000n,
  poolFee: 0,
  tickSpacing: 60,
  poolId: "0xp00l",
  buybackEnabled: false,
  creatorTaxBps: 0,
  exists: true,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buyTokens routes by launch phase", () => {
  it("phase 0: quotes and buys on the bonding curve with a 1% slippage floor, net of any refund", async () => {
    curveQuoteBuy.mockResolvedValue({ tokensOut: 1_000_000n, spent: 100n, refund: 0n });
    curveBuy.mockResolvedValue({ hash: "0xbuy", tokensOut: 999_000n, refundWei: 7n });

    const result = await buyTokens(launch(0) as never, 100n);

    expect(curveQuoteBuy).toHaveBeenCalledWith(CURVE, 100n, TREASURY);
    expect(curveBuy).toHaveBeenCalledWith(expect.objectContaining({ address: TREASURY }), CURVE, 100n, 990_000n, TREASURY);
    expect(v4QuoteExactIn).not.toHaveBeenCalled();
    expect(result).toEqual({ hash: "0xbuy", tokensOut: 999_000n, spentWei: 93n });
  });

  it("phase 2: quotes and swaps on the Uniswap v4 pool, never touching the curve", async () => {
    v4QuoteExactIn.mockResolvedValue(2_000_000n);
    v4SwapExactIn.mockResolvedValue({ hash: "0xswap", out: 1_990_000n });

    const result = await buyTokens(launch(2) as never, 500n);

    expect(v4QuoteExactIn).toHaveBeenCalledWith(expect.objectContaining({ phase: 2 }), { ethIn: 500n });
    expect(v4SwapExactIn).toHaveBeenCalledWith(expect.objectContaining({ address: TREASURY }), expect.objectContaining({ phase: 2 }), { ethIn: 500n }, 1_980_000n, TREASURY);
    expect(curveQuoteBuy).not.toHaveBeenCalled();
    expect(curveBuy).not.toHaveBeenCalled();
    expect(result).toEqual({ hash: "0xswap", tokensOut: 1_990_000n, spentWei: 500n });
  });

  it("phases 1 and 3 have no market and throw before anything is signed", async () => {
    await expect(buyTokens(launch(1) as never, 100n)).rejects.toThrow(/phase 1/);
    await expect(buyTokens(launch(3) as never, 100n)).rejects.toThrow(/phase 3/);
    expect(curveBuy).not.toHaveBeenCalled();
    expect(v4SwapExactIn).not.toHaveBeenCalled();
  });

  it("refuses a zero quote instead of sending a buy that would fill for nothing", async () => {
    curveQuoteBuy.mockResolvedValue({ tokensOut: 0n, spent: 0n, refund: 100n });
    await expect(buyTokens(launch(0) as never, 100n)).rejects.toThrow(/quotes 0 tokens/);
    expect(curveBuy).not.toHaveBeenCalled();
  });
});
