import type * as Db from "@pyre/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Solana PYRE coin's creator fees: 25% of what the treasury receives (USD at credit time)
 * funds the REFUND pool while any holder still has eligible wei left (owed scaled by the snapshot
 * PYRE still held), never twice for the same transaction signature, and nothing once all holders
 * are settled or sold out. The treasury may be the coin creator (its claim is the receipt) or a
 * fee-sharing shareholder (every distribution that paid it is a receipt, whoever sent it); when
 * the fees go to someone else nothing is credited and reconcile reports it.
 */

const MINT = "PyreMint11111111111111111111111111111111111";

const fx = vi.hoisted(() => {
  const ledger: Array<{ account: string; deltaMicros: bigint; refType: string; refId: string }> = [];
  const credits = new Map<string, { signature: string; lamports: unknown; usdMicros: bigint }>();
  const settings = new Map<string, unknown>();
  const holder = { owedWei: 10n, settledWei: 4n, balanceUnits: 100n, minBalanceUnits: 100n };
  const state = { holders: [holder] as Array<typeof holder> };
  const zeroAggregate = { _sum: { deltaMicros: null, creditMicros: null, paidMicros: null, usdMicros: null }, _count: 0 };
  // Prisma queries are lazy: nothing runs until awaited (or until `$transaction` runs the batch).
  const lazy = <T,>(run: () => T): PromiseLike<T> => ({ then: (ok, fail) => Promise.resolve().then(run).then(ok, fail) });
  const prisma = {
    refundHolder: {
      fields: { owedWei: "owedWei", balanceUnits: "balanceUnits", currentBalanceUnits: "currentBalanceUnits" },
      findMany: vi.fn(async (args: { select?: { address?: boolean } }) => (args.select?.address ? [] : state.holders.map((h) => ({ ...h })))),
      aggregate: vi.fn(async () => zeroAggregate),
    },
    refundPayout: { aggregate: vi.fn(async () => zeroAggregate), findMany: vi.fn(async () => []) },
    ledgerEntry: {
      create: vi.fn(({ data }: { data: (typeof ledger)[number] }) =>
        lazy(() => {
          ledger.push(data);
          return data;
        }),
      ),
      aggregate: vi.fn(async () => zeroAggregate),
    },
    refundFeeCredit: {
      findUnique: vi.fn(async ({ where }: { where: { signature: string } }) => credits.get(where.signature) ?? null),
      create: vi.fn(({ data }: { data: { signature: string; lamports: unknown; usdMicros: bigint } }) =>
        lazy(() => {
          if (credits.has(data.signature)) throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on signature", { code: "P2002", clientVersion: "test" });
          credits.set(data.signature, data);
          return data;
        }),
      ),
    },
    platformSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null)),
      upsert: vi.fn(async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
        settings.set(where.key, update.value);
      }),
    },
    // Array transactions run their queries in order and atomically, like Postgres: if any write fails, none of them stays.
    $transaction: vi.fn(async (ops: Array<PromiseLike<unknown>>) => {
      const before = { ledger: ledger.length, credits: new Map(credits) };
      try {
        const results: unknown[] = [];
        for (const op of ops) results.push(await op);
        return results;
      } catch (err) {
        ledger.length = before.ledger;
        credits.clear();
        for (const [k, v] of before.credits) credits.set(k, v);
        throw err;
      }
    }),
  };
  const claimPyreSolFees = vi.fn();
  const pyreSolFeeReceipts = vi.fn();
  const fetchTransaction = vi.fn();
  const lamportDelta = vi.fn();
  class SolanaTransactionUnconfirmedError extends Error {
    constructor(readonly signature: string) {
      super(`solana transaction ${signature} could not be confirmed`);
    }
  }
  const signer = { kind: "treasury-keypair", publicKey: "TreasuryKey" };
  const venue = { treasury: () => ({ chain: "solana", address: "Treasury1111", signer }), nativePriceUsd: vi.fn(async () => 150) };
  return { ledger, credits, settings, state, holder, prisma, venue, signer, claimPyreSolFees, pyreSolFeeReceipts, fetchTransaction, lamportDelta, SolanaTransactionUnconfirmedError, audit: vi.fn() };
});

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma: fx.prisma }));
vi.mock("@pyre/chain", () => ({
  adapterFor: () => fx.venue,
  solanaEnabled: () => true,
  solSigner: (acct: { signer: unknown }) => acct.signer,
  claimPyreSolFees: fx.claimPyreSolFees,
  pyreSolFeeReceipts: fx.pyreSolFeeReceipts,
  fetchTransaction: fx.fetchTransaction,
  lamportDelta: fx.lamportDelta,
  SolanaTransactionUnconfirmedError: fx.SolanaTransactionUnconfirmedError,
}));
vi.mock("../src/workers/chain/env.js", () => ({ chainWorkerEnv: () => ({ PYRE_SOL_MINT: MINT }) }));
vi.mock("../src/workers/chain/publish.js", () => ({ publishGlobal: vi.fn(), publishEvent: vi.fn() }));
vi.mock("../src/workers/chain/launchState.js", () => ({ syncLaunchPhase: vi.fn() }));
vi.mock("../src/lib/audit.js", () => ({ audit: fx.audit }));
vi.mock("../src/lib/lock.js", () => ({ withLock: vi.fn() }));

// Dynamic import: the modules bind `@pyre/db` and `@pyre/chain` at load time, so they must come after the mocks.
const { sweepPyreSolFees } = await import("../src/workers/chain/feeSweep.js");
const { checkRefunds } = await import("../src/workers/reconcile/refunds.js");
const { Prisma } = await vi.importActual<typeof Db>("@pyre/db");

const warn = vi.fn();
const error = vi.fn();
const log = { child: () => log, info: vi.fn(), warn, error } as never;
const reconcile = () => checkRefunds({ log } as never);

const CONFIG = "SharingConfigPda1111111111111111111111111111";
const creatorClaim = { route: "creator", creator: "Treasury1111", amount: 2_000_000_000n, hash: "claimSig1" }; // 2 SOL at $150 = $300
const sharedClaim = (amount: bigint, hash: string | null) => ({
  route: "shared",
  creator: CONFIG,
  shareholders: [
    { address: "Treasury1111", shareBps: 5_000 },
    { address: "Founder1111", shareBps: 5_000 },
  ],
  treasuryShareBps: 5_000,
  amount,
  hash,
});
const receipt = (signature: string, lamports: bigint) => ({ signature, slot: 1, blockTime: 1_790_000_000, treasuryLamports: lamports, eventLamports: lamports, balanceLamports: lamports });
const scanResult = (receipts: Array<ReturnType<typeof receipt>>, head: string | null, oldest: string | null, reachedUntil = true) => ({ receipts, head, oldest, reachedUntil });
const cursor = () => fx.settings.get("refund:distributionCursor") as { signature: string | null; catchUp: { head: string; before: string } | null } | undefined;
const pending = () => fx.settings.get("refund:pendingCreatorClaims") as Array<{ signature: string; broadcastAt: string }> | undefined;

beforeEach(() => {
  fx.ledger.length = 0;
  fx.credits.clear();
  fx.settings.clear();
  fx.state.holders = [fx.holder];
  vi.clearAllMocks();
  fx.claimPyreSolFees.mockResolvedValue(creatorClaim);
  fx.pyreSolFeeReceipts.mockResolvedValue(scanResult([], null, null));
});

describe("sweepPyreSolFees", () => {
  it("credits 25% of the claim's USD value to REFUND under the claim signature", async () => {
    await sweepPyreSolFees(log);
    expect(fx.claimPyreSolFees).toHaveBeenCalledWith(fx.signer, MINT);
    expect(fx.ledger).toEqual([expect.objectContaining({ account: "REFUND", deltaMicros: 75_000_000n, refType: "PlatformFee", refId: "claimSig1" })]);
    expect(fx.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PLATFORM_FEE_CLAIM", meta: expect.objectContaining({ chain: "solana", route: "creator", treasuryShareBps: 10_000, refundMicros: 75_000_000n }) }),
    );
    expect(warn).not.toHaveBeenCalled();
    expect((await reconcile()).findings).toEqual([]);
    expect(fx.pyreSolFeeReceipts).not.toHaveBeenCalled();
  });

  it("credits a claim signature only once", async () => {
    await sweepPyreSolFees(log);
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(1);
  });

  it("credits nothing once every holder is settled, but still records the claim", async () => {
    fx.state.holders = [];
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
    expect(fx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "PLATFORM_FEE_CLAIM", meta: expect.objectContaining({ refundMicros: 0n }) }));
  });

  it("credits nothing when the only unsettled holders sold enough that eligibility is already settled", async () => {
    // owed 10 wei, settled 4, kept 30% of the snapshot balance → eligible 3 ≤ settled; another sold out entirely.
    fx.state.holders = [{ ...fx.holder, minBalanceUnits: 30n }, { ...fx.holder, settledWei: 0n, minBalanceUnits: 0n }];
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
  });

  it("credits nothing when there was nothing to claim", async () => {
    fx.claimPyreSolFees.mockResolvedValueOnce({ ...creatorClaim, amount: 0n, hash: null });
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
    expect(fx.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "PLATFORM_FEE_CLAIM" }));
  });

  it("credits its own distribution from the receipts scan, once, with the treasury's share only", async () => {
    // The distribute paid 4 SOL in total; the treasury, at 50%, received 2 SOL ($300): only that counts.
    fx.claimPyreSolFees.mockResolvedValue(sharedClaim(2_000_000_000n, "distributeSig1"));
    fx.pyreSolFeeReceipts.mockResolvedValue(scanResult([receipt("distributeSig1", 2_000_000_000n)], "distributeSig1", "distributeSig1"));
    await sweepPyreSolFees(log);
    await sweepPyreSolFees(log);
    expect(fx.ledger).toEqual([expect.objectContaining({ account: "REFUND", deltaMicros: 75_000_000n, refType: "PlatformFee", refId: "distributeSig1" })]);
    expect(fx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "PLATFORM_FEE_CLAIM", meta: expect.objectContaining({ route: "shared", creator: CONFIG, treasuryShareBps: 5_000, refundMicros: null }) }));
    expect(fx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "PLATFORM_FEE_DISTRIBUTION", meta: expect.objectContaining({ signature: "distributeSig1", lamports: 2_000_000_000n, refundMicros: 75_000_000n }) }));
    expect(fx.audit.mock.calls.filter(([a]) => a.action === "PLATFORM_FEE_DISTRIBUTION")).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect((await reconcile()).findings).toEqual([]);
  });

  it("credits nothing and reports REFUND_FEES_NOT_ROUTED when another wallet is the creator", async () => {
    fx.claimPyreSolFees.mockResolvedValue({ route: "foreign", creator: "Founder1111", amount: 0n, hash: null });
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
    expect(fx.pyreSolFeeReceipts).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ route: "foreign", creator: "Founder1111" }), expect.any(String));
    expect(fx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "PLATFORM_FEE_ROUTE", meta: expect.objectContaining({ route: "foreign", creator: "Founder1111", previous: null }) }));

    const outcome = await reconcile();
    expect(outcome.findings).toEqual([expect.objectContaining({ code: "REFUND_FEES_NOT_ROUTED", route: "foreign", creator: "Founder1111", mint: MINT })]);
    expect(outcome.findings[0]!.detail).toContain("Founder1111");

    // An unchanged route is not re-audited on the next pass.
    fx.audit.mockClear();
    await sweepPyreSolFees(log);
    expect(fx.audit).not.toHaveBeenCalled();
  });

  it("reports REFUND_FEES_NOT_ROUTED naming the shareholders when the treasury is not one of them", async () => {
    const shareholders = [{ address: "Founder1111", shareBps: 10_000 }];
    fx.claimPyreSolFees.mockResolvedValue({ route: "shared", creator: CONFIG, shareholders, treasuryShareBps: 0, amount: 0n, hash: null });
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const outcome = await reconcile();
    expect(outcome.findings).toEqual([expect.objectContaining({ code: "REFUND_FEES_NOT_ROUTED", route: "shared", creator: CONFIG, shareholders })]);
    expect(outcome.findings[0]!.detail).toContain("Founder1111 (10000 bps)");

    // Once the founder points the fees at the treasury, the finding clears.
    fx.claimPyreSolFees.mockResolvedValue({ route: "shared", creator: CONFIG, shareholders: [{ address: "Treasury1111", shareBps: 10_000 }], treasuryShareBps: 10_000, amount: 0n, hash: null });
    await sweepPyreSolFees(log);
    expect((await reconcile()).findings).toEqual([]);
  });

  it("credits each signature once at the database level: a concurrent insert of the same credit leaves no second entry", async () => {
    // Another writer credited the same claim between our lookup and our insert.
    fx.prisma.refundFeeCredit.findUnique.mockResolvedValueOnce(null);
    fx.credits.set("claimSig1", { signature: "claimSig1", lamports: 2_000_000_000n, usdMicros: 75_000_000n });
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
    expect(fx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "PLATFORM_FEE_CLAIM", meta: expect.objectContaining({ hash: "claimSig1", refundMicros: 0n }) }));
    expect(error).not.toHaveBeenCalled();
  });

  it("records the credited signature with its lamports and share alongside the ledger entry", async () => {
    await sweepPyreSolFees(log);
    expect(fx.credits.get("claimSig1")).toMatchObject({ usdMicros: 75_000_000n });
    expect(String(fx.credits.get("claimSig1")!.lamports)).toBe("2000000000");
    expect(fx.ledger).toEqual([expect.objectContaining({ refId: "claimSig1", deltaMicros: 75_000_000n })]);
  });

  it("still fails the credit on any other database error", async () => {
    fx.prisma.ledgerEntry.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", { code: "P2003", clientVersion: "test" }));
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ code: "P2003" }) }), expect.any(String));
  });
});

describe("sweepPyreSolFees — unconfirmed creator claims", () => {
  const nothingToClaim = { ...creatorClaim, amount: 0n, hash: null };
  const landed = { meta: { err: null } };

  it("keeps an unconfirmed claim's signature and credits it by the treasury's lamport gain once it lands", async () => {
    fx.claimPyreSolFees.mockRejectedValueOnce(new fx.SolanaTransactionUnconfirmedError("lostSig"));
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
    expect(pending()).toEqual([{ signature: "lostSig", broadcastAt: expect.any(String) }]);

    // Still not found: kept, nothing credited, the claim runs as usual.
    fx.claimPyreSolFees.mockResolvedValue(nothingToClaim);
    fx.fetchTransaction.mockRejectedValueOnce(new fx.SolanaTransactionUnconfirmedError("lostSig"));
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
    expect(pending()).toEqual([expect.objectContaining({ signature: "lostSig" })]);
    expect(fx.claimPyreSolFees).toHaveBeenCalledTimes(2);

    // Landed: 2 SOL at $150 → 25% of $300, under the claim's own signature, resolved before claiming again.
    fx.fetchTransaction.mockResolvedValueOnce(landed);
    fx.lamportDelta.mockReturnValueOnce(2_000_000_000n);
    await sweepPyreSolFees(log);
    expect(fx.fetchTransaction).toHaveBeenLastCalledWith("lostSig");
    expect(fx.lamportDelta).toHaveBeenCalledWith(landed, "TreasuryKey");
    expect(fx.fetchTransaction.mock.invocationCallOrder.at(-1)!).toBeLessThan(fx.claimPyreSolFees.mock.invocationCallOrder.at(-1)!);
    expect(fx.ledger).toEqual([expect.objectContaining({ account: "REFUND", deltaMicros: 75_000_000n, refType: "PlatformFee", refId: "lostSig" })]);
    expect(fx.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PLATFORM_FEE_CLAIM", meta: expect.objectContaining({ route: "creator", hash: "lostSig", lamports: 2_000_000_000n, refundMicros: 75_000_000n, unconfirmedBroadcast: true }) }),
    );
    expect(pending()).toEqual([]);

    await sweepPyreSolFees(log);
    expect(fx.fetchTransaction).toHaveBeenCalledTimes(2);
    expect(fx.ledger).toHaveLength(1);
  });

  it("drops an unconfirmed claim that failed on chain without crediting it", async () => {
    fx.settings.set("refund:pendingCreatorClaims", [{ signature: "failedSig", broadcastAt: "" }]);
    fx.claimPyreSolFees.mockResolvedValue(nothingToClaim);
    fx.fetchTransaction.mockResolvedValueOnce({ meta: { err: { InstructionError: [0, { Custom: 1 }] } } });
    await sweepPyreSolFees(log);
    expect(fx.lamportDelta).not.toHaveBeenCalled();
    expect(fx.ledger).toHaveLength(0);
    expect(pending()).toEqual([]);
  });

  it("keeps at most 20 pending claims, dropping the oldest", async () => {
    const old = Array.from({ length: 20 }, (_, i) => ({ signature: `old${i}`, broadcastAt: "" }));
    fx.settings.set("refund:pendingCreatorClaims", old);
    fx.fetchTransaction.mockRejectedValue(new fx.SolanaTransactionUnconfirmedError("x"));
    fx.claimPyreSolFees.mockRejectedValueOnce(new fx.SolanaTransactionUnconfirmedError("newSig"));
    await sweepPyreSolFees(log);
    fx.fetchTransaction.mockReset();
    expect(pending()!.map((p) => p.signature)).toEqual([...old.slice(1).map((p) => p.signature), "newSig"]);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ dropped: [old[0]] }), expect.any(String));
  });

  it("leaves an unconfirmed distribution to the receipts scan when the route is shared", async () => {
    fx.settings.set("refund:feeRoute", { mint: MINT, treasury: "Treasury1111", route: "shared" });
    fx.claimPyreSolFees.mockRejectedValueOnce(new fx.SolanaTransactionUnconfirmedError("distSig"));
    await sweepPyreSolFees(log);
    expect(pending()).toBeUndefined();
    expect(fx.pyreSolFeeReceipts).toHaveBeenCalled();
  });
});

describe("sweepPyreSolFees — fee-sharing receipts", () => {
  beforeEach(() => {
    fx.claimPyreSolFees.mockResolvedValue(sharedClaim(0n, null));
  });

  it("credits a distribution someone else sent, once, and moves the cursor to it", async () => {
    fx.pyreSolFeeReceipts.mockResolvedValue(scanResult([receipt("botSig", 2_000_000_000n)], "botSig", "botSig"));
    await sweepPyreSolFees(log);
    expect(fx.pyreSolFeeReceipts).toHaveBeenLastCalledWith(MINT, "Treasury1111", undefined, expect.objectContaining({ before: undefined }));
    expect(fx.ledger).toEqual([expect.objectContaining({ account: "REFUND", deltaMicros: 75_000_000n, refType: "PlatformFee", refId: "botSig" })]);
    expect(cursor()).toMatchObject({ signature: "botSig", catchUp: null });

    // Listed again (e.g. the RPC returns it once more): still one credit.
    await sweepPyreSolFees(log);
    expect(fx.pyreSolFeeReceipts).toHaveBeenLastCalledWith(MINT, "Treasury1111", "botSig", expect.objectContaining({ before: undefined }));
    expect(fx.ledger).toHaveLength(1);
  });

  it("credits nothing for a distribution that paid the treasury nothing, and still moves past it", async () => {
    fx.pyreSolFeeReceipts.mockResolvedValue(scanResult([receipt("zeroSig", 0n)], "zeroSig", "zeroSig"));
    await sweepPyreSolFees(log);
    expect(fx.ledger).toHaveLength(0);
    expect(fx.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "PLATFORM_FEE_DISTRIBUTION" }));
    expect(cursor()).toMatchObject({ signature: "zeroSig", catchUp: null });
  });

  it("resumes a capped scan below where it stopped, and only then moves the cursor to the newest signature", async () => {
    fx.settings.set("refund:distributionCursor", { mint: MINT, treasury: "Treasury1111", signature: "s0", catchUp: null, updatedAt: "" });
    fx.pyreSolFeeReceipts.mockResolvedValueOnce(scanResult([receipt("s5", 1_000_000_000n), receipt("s4", 1_000_000_000n)], "s5", "s3", false));
    await sweepPyreSolFees(log);
    expect(fx.pyreSolFeeReceipts).toHaveBeenLastCalledWith(MINT, "Treasury1111", "s0", expect.objectContaining({ before: undefined }));
    expect(cursor()).toMatchObject({ signature: "s0", catchUp: { head: "s5", before: "s3" } });

    fx.pyreSolFeeReceipts.mockResolvedValueOnce(scanResult([receipt("s2", 1_000_000_000n)], "s2", "s1"));
    await sweepPyreSolFees(log);
    expect(fx.pyreSolFeeReceipts).toHaveBeenLastCalledWith(MINT, "Treasury1111", "s0", expect.objectContaining({ before: "s3" }));
    expect(cursor()).toMatchObject({ signature: "s5", catchUp: null });

    await sweepPyreSolFees(log);
    expect(fx.pyreSolFeeReceipts).toHaveBeenLastCalledWith(MINT, "Treasury1111", "s5", expect.objectContaining({ before: undefined }));
    expect(fx.ledger.map((e) => e.refId)).toEqual(["s5", "s4", "s2"]);
  });

  it("never moves the cursor past a receipt whose credit failed", async () => {
    const all = [receipt("s3", 1_000_000_000n), receipt("s2", 1_000_000_000n), receipt("s1", 1_000_000_000n)];
    fx.pyreSolFeeReceipts.mockResolvedValueOnce(scanResult(all, "s3", "s1"));
    // s3's credit succeeds, s2's write fails.
    fx.prisma.ledgerEntry.create.mockImplementationOnce(fx.prisma.ledgerEntry.create.getMockImplementation()!).mockRejectedValueOnce(new Error("db down"));
    await sweepPyreSolFees(log);
    expect(fx.ledger.map((e) => e.refId)).toEqual(["s3"]);
    expect(cursor()).toMatchObject({ signature: null, catchUp: { head: "s3", before: "s3" } });

    fx.pyreSolFeeReceipts.mockResolvedValueOnce(scanResult(all.slice(1), "s2", "s1"));
    await sweepPyreSolFees(log);
    expect(fx.pyreSolFeeReceipts).toHaveBeenLastCalledWith(MINT, "Treasury1111", undefined, expect.objectContaining({ before: "s3" }));
    expect(fx.ledger.map((e) => e.refId)).toEqual(["s3", "s2", "s1"]);
    expect(cursor()).toMatchObject({ signature: "s3", catchUp: null });
  });

  it("leaves the cursor alone when the scan itself fails", async () => {
    fx.settings.set("refund:distributionCursor", { mint: MINT, treasury: "Treasury1111", signature: "s0", catchUp: null, updatedAt: "" });
    fx.pyreSolFeeReceipts.mockRejectedValueOnce(new Error("rpc down"));
    await sweepPyreSolFees(log);
    expect(cursor()).toMatchObject({ signature: "s0", catchUp: null });
    expect(fx.ledger).toHaveLength(0);
  });
});
