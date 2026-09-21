import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The PAYOUTS reconcile settles treasury payouts the API broadcast but could not confirm. The
 * routing is what matters: a confirmed receipt finalises what the API would have written after
 * the transfer, a reverted one releases the funds it held back, a missing one is only reported —
 * and a row already settled is never touched again.
 */

const HASH_OK = "0x" + "aa".repeat(32);
const HASH_REVERT = "0x" + "bb".repeat(32);
const HASH_MISSING = "0x" + "cc".repeat(32);

const fx = vi.hoisted(() => {
  const audits: Array<{ id: string; action: string; targetType: string; targetId: string; meta: unknown; createdAt: Date }> = [];
  const receipts: Record<string, "success" | "reverted"> = {};
  const ledgerEntry = { update: vi.fn(async () => ({})), create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})) };
  const pyreStake = { update: vi.fn(async () => ({})) };
  const bounty = { updateMany: vi.fn(async () => ({ count: 1 })) };
  const auditLog = {
    findMany: vi.fn(async ({ where }: { where: { action: string } }) => audits.filter((a) => a.action === where.action)),
    create: vi.fn(async ({ data }: { data: { action: string; targetType: string; targetId: string; meta: unknown } }) => {
      audits.push({ id: `aud_${audits.length + 1}`, createdAt: new Date(), ...data });
      return {};
    }),
  };
  const prisma = { ledgerEntry, pyreStake, bounty, auditLog, $transaction: async (ops: unknown[]) => Promise.all(ops) };
  const getTransactionReceipt = vi.fn(async ({ hash }: { hash: string }) => {
    const status = receipts[hash];
    if (!status) throw new Error("receipt not found");
    return { status };
  });
  return { audits, receipts, prisma, ledgerEntry, pyreStake, bounty, getTransactionReceipt };
});

vi.mock("@pyre/db", () => ({ prisma: fx.prisma }));
vi.mock("@pyre/chain", () => ({ publicClient: () => ({ getTransactionReceipt: fx.getTransactionReceipt }), getEthPriceUsd: async () => 2000 }));
vi.mock("../src/lib/audit.js", () => ({
  audit: async (input: { action: string; targetType: string; targetId: string; meta: unknown }) => fx.prisma.auditLog.create({ data: input }),
}));

// Dynamic import: the module binds `@pyre/db` and `@pyre/chain` at load time, so it must come after the mocks.
const { checkPayouts } = await import("../src/workers/reconcile/payouts.js");

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = { redis: {}, log } as never;
const unconfirmed = (targetType: string, targetId: string, meta: Record<string, unknown>, ageMs = 0) => {
  fx.audits.push({ id: `aud_${fx.audits.length + 1}`, action: "PAYOUT_UNCONFIRMED", targetType, targetId, meta, createdAt: new Date(Date.now() - ageMs) });
};

beforeEach(() => {
  vi.clearAllMocks();
  fx.audits.length = 0;
  for (const k of Object.keys(fx.receipts)) delete fx.receipts[k];
});

describe("PAYOUTS reconcile", () => {
  it("finalises a confirmed fee claim: memo + treasury debit, then marks it resolved", async () => {
    fx.receipts[HASH_OK] = "success";
    unconfirmed("LedgerEntry", "led_1", { kind: "FEES_CLAIM", txHash: HASH_OK, userId: "u1", usdMicros: "5000000", wei: "2500000000000000" });

    const outcome = await checkPayouts(ctx);

    expect(outcome).toMatchObject({ ok: true, checked: 1, drifted: 0, repaired: 1 });
    expect(fx.ledgerEntry.update).toHaveBeenCalledWith({ where: { id: "led_1" }, data: { memo: `fees claim ${HASH_OK}` } });
    expect(fx.ledgerEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ account: "TREASURY", deltaMicros: -5_000_000n, refId: "u1" }) });
    expect(fx.audits).toContainEqual(expect.objectContaining({ action: "PAYOUT_RESOLVED", meta: expect.objectContaining({ unconfirmedId: "aud_1", receipt: "success" }) }));

    // The resolved row is skipped on the next pass: nothing is finalised twice.
    await checkPayouts(ctx);
    expect(fx.ledgerEntry.create).toHaveBeenCalledTimes(1);
  });

  it("releases a reverted unstake and restores reverted staker rewards by increment", async () => {
    fx.receipts[HASH_REVERT] = "reverted";
    unconfirmed("PyreStake", "s1", { kind: "PYRE_UNSTAKE", txHash: HASH_REVERT });
    unconfirmed("User", "u1", { kind: "PYRE_CLAIM", txHash: HASH_REVERT, userId: "u1", usdMicros: "3000000", stakes: [{ id: "s2", appId: "a1", earnedMicros: "3000000" }] });

    const outcome = await checkPayouts(ctx);

    expect(outcome).toMatchObject({ repaired: 2, drifted: 0 });
    expect(fx.pyreStake.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { withdrawnAt: null, withdrawTx: null } });
    expect(fx.pyreStake.update).toHaveBeenCalledWith({ where: { id: "s2" }, data: { earnedMicros: { increment: 3_000_000n } } });
    expect(fx.ledgerEntry.createMany).not.toHaveBeenCalled();
  });

  it("reports a payout with no receipt yet and escalates it to drift once stale", async () => {
    unconfirmed("Bounty", "b1", { kind: "BOUNTY_PAYOUT", txHash: HASH_MISSING, wei: "1000000000000000000" });
    unconfirmed("Bounty", "b2", { kind: "BOUNTY_PAYOUT", txHash: HASH_MISSING, wei: "1000000000000000000" }, 2 * 60 * 60_000);

    const outcome = await checkPayouts(ctx);

    expect(outcome).toMatchObject({ checked: 2, repaired: 0, drifted: 1 });
    expect(outcome.findings.map((f) => f.code).sort()).toEqual(["PAYOUT_DROPPED", "PAYOUT_PENDING"]);
    expect(fx.bounty.updateMany).not.toHaveBeenCalled();
    expect(fx.audits.filter((a) => a.action === "PAYOUT_RESOLVED")).toHaveLength(0);
  });
});
