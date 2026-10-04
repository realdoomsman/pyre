import { OnlinePumpSdk, PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, feeSharingConfigPda, type BondingCurve, type SharingConfig } from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK, type Pool } from "@pump-fun/pump-swap-sdk";
import { Keypair, PublicKey, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import BN from "bn.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimPyreSolFees, pumpCreatorFeeRoute } from "./feesClaim.js";

const { accounts, getMinimumBalanceForRentExemption, sendInstructions, lamportDelta } = vi.hoisted(() => ({
  accounts: new Map<string, unknown>(),
  getMinimumBalanceForRentExemption: vi.fn(async () => 890_880),
  sendInstructions: vi.fn(),
  lamportDelta: vi.fn(),
}));
vi.mock("../solana/connection.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  connection: () => ({
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null),
    getMinimumBalanceForRentExemption,
  }),
}));
vi.mock("../solana/send.js", async (importOriginal) => ({ ...((await importOriginal()) as object), sendInstructions, lamportDelta }));

const treasury = Keypair.generate();
const founder = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const MINT = mint.toBase58();
const config = feeSharingConfigPda(mint);

/** Placeholder accounts: the decoders are stubbed, only presence matters to the resolver. */
const info = (): AccountInfo<Buffer> => ({ data: Buffer.alloc(0), lamports: 1, owner: PublicKey.default, executable: false });
let curveCreator: PublicKey | undefined;
let poolCreator: PublicKey | undefined;
let shareholders: SharingConfig["shareholders"] = [];

const onCurve = (creator: PublicKey): void => {
  accounts.set(bondingCurvePda(mint).toBase58(), info());
  curveCreator = creator;
};
const graduated = (creator: PublicKey): void => {
  accounts.set(canonicalPumpPoolPda(mint).toBase58(), info());
  poolCreator = creator;
};
const sharing = (holders: Array<[PublicKey, number]>): void => {
  accounts.set(config.toBase58(), info());
  shareholders = holders.map(([address, shareBps]) => ({ address, shareBps }));
};

beforeEach(() => {
  accounts.clear();
  curveCreator = undefined;
  poolCreator = undefined;
  vi.clearAllMocks();
  vi.spyOn(PUMP_SDK, "decodeBondingCurveNullable").mockImplementation(() => ({ creator: curveCreator! }) as BondingCurve);
  vi.spyOn(PUMP_AMM_SDK, "decodePoolNullable").mockImplementation(() => ({ coinCreator: poolCreator! }) as Pool);
  vi.spyOn(PUMP_SDK, "decodeSharingConfig").mockImplementation(() => ({ version: 2, mint, admin: PublicKey.default, adminRevoked: true, shareholders }) as SharingConfig);
});

describe("pumpCreatorFeeRoute", () => {
  it("is `creator` when the treasury created the coin", async () => {
    onCurve(treasury.publicKey);
    expect(await pumpCreatorFeeRoute(MINT, treasury.publicKey)).toEqual({ route: "creator", creator: treasury.publicKey.toBase58() });
  });

  it("is `foreign` when another wallet is the creator", async () => {
    onCurve(founder);
    expect(await pumpCreatorFeeRoute(MINT, treasury.publicKey)).toEqual({ route: "foreign", creator: founder.toBase58() });
  });

  it("follows the pool's coinCreator once graduated, not the curve's", async () => {
    onCurve(founder);
    graduated(config);
    sharing([[treasury.publicKey, 10_000]]);
    expect(await pumpCreatorFeeRoute(MINT, treasury.publicKey)).toMatchObject({ route: "shared", creator: config.toBase58(), treasuryShareBps: 10_000 });
  });

  it("is `shared` with the treasury's share summed from the sharing config, 0 when it is not a shareholder", async () => {
    onCurve(config);
    sharing([
      [founder, 7_500],
      [treasury.publicKey, 2_500],
    ]);
    expect(await pumpCreatorFeeRoute(MINT, treasury.publicKey)).toEqual({
      route: "shared",
      creator: config.toBase58(),
      shareholders: [
        { address: founder.toBase58(), shareBps: 7_500 },
        { address: treasury.publicKey.toBase58(), shareBps: 2_500 },
      ],
      treasuryShareBps: 2_500,
    });
    sharing([[founder, 10_000]]);
    expect(await pumpCreatorFeeRoute(MINT, treasury.publicKey)).toMatchObject({ route: "shared", treasuryShareBps: 0 });
  });

  it("refuses a mint pump never launched", async () => {
    await expect(pumpCreatorFeeRoute(MINT, treasury.publicKey)).rejects.toThrow(/no pump bonding curve/);
  });
});

describe("claimPyreSolFees", () => {
  const distributeIx = new TransactionInstruction({ keys: [], programId: PublicKey.default, data: Buffer.alloc(0) });

  beforeEach(() => {
    vi.spyOn(OnlinePumpSdk.prototype, "getMinimumDistributableFee").mockResolvedValue({ canDistribute: true, distributableFees: new BN(84_979_238) } as never);
    vi.spyOn(OnlinePumpSdk.prototype, "buildDistributeCreatorFeesInstructions").mockResolvedValue({ instructions: [distributeIx], isGraduated: false });
    sendInstructions.mockResolvedValue({ signature: "distSig", slot: 1, tx: {} });
    lamportDelta.mockReturnValue(1_234_000n);
  });

  it("distributes as the treasury and returns its own lamport gain", async () => {
    onCurve(config);
    sharing([[treasury.publicKey, 10_000]]);
    expect(await claimPyreSolFees(treasury, MINT)).toMatchObject({ route: "shared", treasuryShareBps: 10_000, amount: 1_234_000n, hash: "distSig" });
    expect(OnlinePumpSdk.prototype.buildDistributeCreatorFeesInstructions).toHaveBeenCalledWith(mint, { payer: treasury.publicKey });
    expect(sendInstructions).toHaveBeenCalledWith(treasury, [distributeIx], expect.objectContaining({ computeUnits: expect.any(Number) }));
  });

  it("sends nothing while pump says it cannot distribute, or there is nothing to distribute", async () => {
    onCurve(config);
    sharing([[treasury.publicKey, 10_000]]);
    vi.mocked(OnlinePumpSdk.prototype.getMinimumDistributableFee).mockResolvedValueOnce({ canDistribute: false, distributableFees: new BN(5_000_000) } as never);
    expect(await claimPyreSolFees(treasury, MINT)).toMatchObject({ route: "shared", amount: 0n, hash: null });
    // Mainnet reports canDistribute for an empty vault too.
    vi.mocked(OnlinePumpSdk.prototype.getMinimumDistributableFee).mockResolvedValueOnce({ canDistribute: true, distributableFees: new BN(0) } as never);
    expect(await claimPyreSolFees(treasury, MINT)).toMatchObject({ route: "shared", amount: 0n, hash: null });
    expect(sendInstructions).not.toHaveBeenCalled();
  });

  it("sends nothing when the treasury is not a shareholder or another wallet is the creator", async () => {
    onCurve(config);
    sharing([[founder, 10_000]]);
    expect(await claimPyreSolFees(treasury, MINT)).toMatchObject({ route: "shared", treasuryShareBps: 0, amount: 0n, hash: null });
    curveCreator = founder;
    expect(await claimPyreSolFees(treasury, MINT)).toEqual({ route: "foreign", creator: founder.toBase58(), amount: 0n, hash: null });
    expect(OnlinePumpSdk.prototype.getMinimumDistributableFee).not.toHaveBeenCalled();
    expect(sendInstructions).not.toHaveBeenCalled();
  });

  it("collects as the creator when the treasury created the coin (empty vaults: nothing sent)", async () => {
    onCurve(treasury.publicKey);
    expect(await claimPyreSolFees(treasury, MINT)).toEqual({ route: "creator", creator: treasury.publicKey.toBase58(), amount: 0n, hash: null });
    expect(OnlinePumpSdk.prototype.buildDistributeCreatorFeesInstructions).not.toHaveBeenCalled();
    expect(sendInstructions).not.toHaveBeenCalled();
  });
});
