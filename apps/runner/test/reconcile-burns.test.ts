import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The BURNS reconcile compares recorded burns with on-chain supply. Two outcomes matter to an
 * operator: a token address that is not a contract (seeded demo rows) is skipped with a note
 * rather than failing the pass, while a real token whose reads fail still marks the check as
 * unable to complete — and recorded burns that exceed the chain are always reported as drift.
 */

const CONTRACT = "0x1000000000000000000000000000000000000001";
const EMPTY = "0x2000000000000000000000000000000000000002";
const BROKEN = "0x3000000000000000000000000000000000000003";

const fx = vi.hoisted(() => {
  const apps: Array<{ id: string; slug: string; tokenAddress: string }> = [];
  const burned: Record<string, bigint> = {};
  const getCode = vi.fn(async ({ address }: { address: string }) => (address === EMPTY ? "0x" : "0x6080"));
  const getTokenInfo = vi.fn(async (token: string) => {
    if (token === BROKEN) throw new Error("execution reverted");
    return { burnedUnits: 1_000n };
  });
  const prisma = {
    app: { findMany: vi.fn(async () => apps) },
    buyback: {
      groupBy: vi.fn(async () => apps.filter((a) => burned[a.id] !== undefined).map((a) => ({ appId: a.id, _sum: { burnedUnits: burned[a.id], tokensBurned: burned[a.id] }, _count: 1 }))),
    },
  };
  return { apps, burned, getCode, getTokenInfo, prisma };
});

vi.mock("@pyre/db", () => ({ prisma: fx.prisma, big: (v: unknown) => BigInt(String(v ?? 0)) }));
vi.mock("@pyre/chain", () => ({ publicClient: () => ({ getCode: fx.getCode }), getTokenInfo: fx.getTokenInfo }));
vi.mock("../src/workers/chain/env.js", () => ({ chainWorkerEnv: () => ({}) }));

// Dynamic import: the module binds `@pyre/db` and `@pyre/chain` at load time, so it must come after the mocks.
const { checkBurns } = await import("../src/workers/reconcile/burns.js");

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = { redis: {}, log } as never;

beforeEach(() => {
  vi.clearAllMocks();
  fx.apps.length = 0;
  for (const k of Object.keys(fx.burned)) delete fx.burned[k];
});

describe("BURNS reconcile", () => {
  it("skips a token address with no bytecode as a note, not a failure", async () => {
    fx.apps.push({ id: "a1", slug: "demo", tokenAddress: EMPTY });
    fx.burned.a1 = 5_000n;

    const outcome = await checkBurns(ctx);

    expect(outcome).toMatchObject({ ok: true, checked: 1, drifted: 0, repaired: 0 });
    expect(outcome.findings).toEqual([expect.objectContaining({ code: "BURN_TOKEN_NOT_A_CONTRACT", appId: "a1", slug: "demo" })]);
    expect(fx.getTokenInfo).not.toHaveBeenCalled();
  });

  it("still fails the pass when a real token's reads fail, and reports drift when the ledger exceeds the chain", async () => {
    fx.apps.push({ id: "ok", slug: "ok", tokenAddress: CONTRACT }, { id: "over", slug: "over", tokenAddress: CONTRACT }, { id: "bad", slug: "bad", tokenAddress: BROKEN });
    fx.burned.ok = 1_000n;
    fx.burned.over = 1_001n;

    const outcome = await checkBurns(ctx);

    expect(outcome.ok).toBe(false);
    expect(outcome.drifted).toBe(1);
    expect(outcome.findings.map((f) => [f.code, f.appId])).toEqual([
      ["BURNS_EXCEED_CHAIN", "over"],
      ["BURN_SUPPLY_UNREADABLE", "bad"],
    ]);
  });
});
