import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The BURNS reconcile compares recorded $PYRE burns with on-chain supply. What matters to an
 * operator: a burn stuck between buy and burn is drift (bought $PYRE sitting in the treasury is
 * indistinguishable from staked custody), recorded burns can never exceed what the chain shows
 * removed, the burn proof must match what was sent to burn(), and a token whose reads fail marks
 * the pass unable to complete rather than silently green.
 */

const fx = vi.hoisted(() => {
  const PYRE = "0x1000000000000000000000000000000000000001";
  const state = { token: PYRE as string | undefined, burnedUnits: 0n, tokensBurned: 0n, count: 0, stuck: [] as Array<{ id: string; status: string; swapTx: string | null; error: string | null; createdAt: Date }>, chainBurned: 1_000n, chainFails: false };
  const getTokenInfo = vi.fn(async () => {
    if (state.chainFails) throw new Error("execution reverted");
    return { burnedUnits: state.chainBurned };
  });
  const prisma = {
    coinBurn: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
    pyreBurn: {
      aggregate: vi.fn(async () => ({ _sum: { burnedUnits: state.burnedUnits, tokensBurned: state.tokensBurned }, _count: state.count })),
      findMany: vi.fn(async () => state.stuck),
    },
  };
  return { PYRE, state, getTokenInfo, prisma };
});

vi.mock("@pyre/db", () => ({ prisma: fx.prisma, big: (v: unknown) => BigInt(String(v ?? 0)) }));
vi.mock("@pyre/chain", () => ({ getTokenInfo: fx.getTokenInfo, solanaEnabled: () => false, adapterFor: () => { throw new Error("unused"); } }));
vi.mock("../src/workers/chain/env.js", () => ({ chainWorkerEnv: () => ({ PYRE_TOKEN: fx.state.token }) }));

// Dynamic import: the module binds `@pyre/db` and `@pyre/chain` at load time, so it must come after the mocks.
const { checkBurns } = await import("../src/workers/reconcile/burns.js");

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = { redis: {}, log } as never;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fx.state, { token: fx.PYRE, burnedUnits: 0n, tokensBurned: 0n, count: 0, stuck: [], chainBurned: 1_000n, chainFails: false });
});

describe("BURNS reconcile", () => {
  it("is a no-op before $PYRE is launched", async () => {
    fx.state.token = undefined;
    const outcome = await checkBurns(ctx);
    expect(outcome).toMatchObject({ ok: true, checked: 0, drifted: 0 });
    expect(fx.prisma.pyreBurn.aggregate).not.toHaveBeenCalled();
  });

  it("passes when the ledger is at or below the chain and every proof matches", async () => {
    Object.assign(fx.state, { burnedUnits: 1_000n, tokensBurned: 1_000n, count: 3 });
    const outcome = await checkBurns(ctx);
    expect(outcome).toMatchObject({ ok: true, checked: 3, drifted: 0, findings: [] });
  });

  it("reports a burn stuck between buy and burn as drift", async () => {
    fx.state.stuck = [{ id: "pb_9", status: "SWAPPED", swapTx: "0xswap", error: null, createdAt: new Date("2026-09-21T00:00:00Z") }];
    const outcome = await checkBurns(ctx);
    expect(outcome.drifted).toBe(1);
    expect(outcome.findings).toEqual([expect.objectContaining({ code: "PYRE_BURN_STUCK", pyreBurnId: "pb_9" })]);
  });

  it("reports drift when the ledger exceeds the chain or the proof does not match what was sent to burn()", async () => {
    Object.assign(fx.state, { burnedUnits: 1_001n, tokensBurned: 1_000n, count: 2 });
    const outcome = await checkBurns(ctx);
    expect(outcome.ok).toBe(true);
    expect(outcome.drifted).toBe(2);
    expect(outcome.findings.map((f) => f.code)).toEqual(["PYRE_BURNS_EXCEED_CHAIN", "PYRE_BURN_PROOF_MISMATCH"]);
  });

  it("marks the pass unable to complete when the token's reads fail", async () => {
    Object.assign(fx.state, { burnedUnits: 500n, tokensBurned: 500n, count: 1, chainFails: true });
    const outcome = await checkBurns(ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toEqual([expect.objectContaining({ code: "BURN_SUPPLY_UNREADABLE" })]);
  });
});
