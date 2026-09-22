import { zeroAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAttestation } from "../browser.js";
import { attestationHash } from "../burn.js";
import { ponsAdapter } from "./adapter.js";
import type { LaunchRecord } from "./read.js";

const { readContract, getTransaction, readLaunch, getPrice, accruingFees, readCurveState, getHolders } = vi.hoisted(() => ({
  readContract: vi.fn(),
  getTransaction: vi.fn(),
  readLaunch: vi.fn(),
  getPrice: vi.fn(),
  accruingFees: vi.fn(),
  readCurveState: vi.fn(),
  getHolders: vi.fn(),
}));
vi.mock("../chain.js", async (importOriginal) => ({ ...((await importOriginal()) as object), publicClient: () => ({ readContract, getTransaction }) }));
vi.mock("./read.js", async (importOriginal) => ({ ...((await importOriginal()) as object), readLaunch, getPrice, accruingFees }));
vi.mock("./curve.js", async (importOriginal) => ({ ...((await importOriginal()) as object), readCurveState }));
vi.mock("../holders.js", async (importOriginal) => ({ ...((await importOriginal()) as object), getHolders }));

const TOKEN = "0x00ca30AAD368e1cd5DD9736b2C2dB1101F30B8D8";
const CURVE = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const ETH = 10n ** 18n;

const launch = (phase: LaunchRecord["phase"]): LaunchRecord => ({
  token: TOKEN,
  curve: CURVE,
  deployer: BUYER,
  creatorFeeRecipient: BUYER,
  pairToken: zeroAddress,
  phase,
  graduationThresholdWei: 4n * ETH,
  poolFee: 0,
  tickSpacing: 200,
  poolId: `0x${"ab".repeat(32)}`,
  buybackEnabled: false,
  creatorTaxBps: 0,
  exists: true,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ponsAdapter", () => {
  it("maps a curve launch onto the venue state with the raised amount from the curve", async () => {
    readLaunch.mockResolvedValue(launch(0));
    getPrice.mockResolvedValue({ priceEth: 0.000001, priceUsd: 0.002, mcapUsd: 1, fdvUsd: 1, progress: 0.25, burnedUnits: 5n, circulatingUnits: 95n, totalSupply: 100n });
    readContract.mockResolvedValue(ETH);
    const state = await ponsAdapter.readLaunch(TOKEN);
    expect(state).toEqual({ exists: true, token: TOKEN, curve: CURVE, pool: null, phase: 0, progress: 0.25, raisedNative: ETH, graduationNative: 4n * ETH, priceNative: 0.000001, totalSupplyUnits: 100n, circulatingUnits: 95n, burnedUnits: 5n });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: CURVE, functionName: "realQuoteReserve" }));
  });

  it("exposes the pool id once graduated", async () => {
    readLaunch.mockResolvedValue(launch(2));
    getPrice.mockResolvedValue({ priceEth: 0.000002, priceUsd: 0, mcapUsd: 0, fdvUsd: 0, progress: 1, burnedUnits: 0n, circulatingUnits: 100n, totalSupply: 100n });
    readContract.mockResolvedValue(4n * ETH);
    expect(await ponsAdapter.readLaunch(TOKEN)).toMatchObject({ phase: 2, pool: `0x${"ab".repeat(32)}`, progress: 1 });
  });

  it("quotes a curve buy with the caller's snipe tax and the PONS fee structure", async () => {
    readLaunch.mockResolvedValue(launch(0));
    readCurveState.mockResolvedValue({ quoteReserve: 10n * ETH, tokenReserve: 1_000_000n * ETH, sellableTokens: 800_000n * ETH, feeBps: 100n, creatorTaxBps: 0n, snipeTaxBps: 500n });
    const q = await ponsAdapter.quoteBuy(TOKEN, ETH, BUYER);
    expect(readCurveState).toHaveBeenCalledWith(CURVE, BUYER);
    expect(q.feeBps).toBe(600);
    expect(q.native).toBe(ETH);
    // 0.94 ETH net into x·y=k on 10 ETH / 1M tokens.
    expect(q.tokenUnits).toBe(((ETH * 94n) / 100n) * 1_000_000n * ETH / (10n * ETH + (ETH * 94n) / 100n));
    expect(q.impact).toBeGreaterThan(0.1);
    // Without a buyer the quote assumes a generic wallet (zero address) for the snipe tax lookup.
    await ponsAdapter.quoteBuy(TOKEN, ETH);
    expect(readCurveState).toHaveBeenLastCalledWith(CURVE, zeroAddress);
  });

  it("reports unswept and claimable fees under the venue names", async () => {
    readLaunch.mockResolvedValue(launch(0));
    accruingFees.mockResolvedValue({ unsweptWei: 3n, escrowWei: 4n });
    expect(await ponsAdapter.accruingFees(TOKEN, BUYER)).toEqual({ unswept: 3n, claimable: 4n });
  });

  it("gates launches on the factory's canLaunch", async () => {
    readContract.mockResolvedValueOnce(false);
    expect(await ponsAdapter.canLaunch(BUYER)).toMatchObject({ ok: false, reason: expect.any(String) });
    readContract.mockResolvedValueOnce(true);
    expect(await ponsAdapter.canLaunch(BUYER)).toEqual({ ok: true });
  });

  it("reads an attestation back from the self-transaction calldata", async () => {
    const digest = attestationHash(["a", "b"]);
    getTransaction.mockResolvedValueOnce({ input: encodeAttestation(digest) });
    expect(await ponsAdapter.readAttestation(`0x${"cd".repeat(32)}`)).toEqual({ digestHex: digest, version: 1 });
    getTransaction.mockResolvedValueOnce({ input: "0x" });
    expect(await ponsAdapter.readAttestation(`0x${"cd".repeat(32)}`)).toBeNull();
    getTransaction.mockRejectedValueOnce(new Error("not found"));
    expect(await ponsAdapter.readAttestation(`0x${"cd".repeat(32)}`)).toBeNull();
  });

  it("translates PONS holder tags onto the venue's vocabulary", async () => {
    getHolders.mockResolvedValue([
      { address: "0x1", units: 1n, share: 0.1, system: "curve" },
      { address: "0x2", units: 1n, share: 0.1, system: "pool-manager" },
      { address: "0x3", units: 1n, share: 0.1, system: "locker" },
      { address: "0x4", units: 1n, share: 0.1, system: "buyback-vault" },
      { address: "0x5", units: 1n, share: 0.1, system: "dead" },
      { address: "0x6", units: 1n, share: 0.1, system: null },
    ]);
    expect((await ponsAdapter.holders(TOKEN, 10)).map((h) => h.system)).toEqual(["liquidity", "liquidity", "locked", "vault", "dead", null]);
    expect(getHolders).toHaveBeenCalledWith(TOKEN, 10);
  });
});
