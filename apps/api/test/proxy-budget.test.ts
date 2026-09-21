import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobToken } from "@pyre/db";
import { GLOBAL_DAILY_COMPUTE_CEILING_USD, MODELS } from "@pyre/shared";

/**
 * Budget enforcement — the invariant that an app can only ever spend the build budget it earned,
 * and that no run of apps can blow past the global daily ceiling. `reserveBudget` optimistically
 * reserves each request's WORST-CASE cost against both the per-token budget and the daily ceiling
 * with a single guarded increment, then `settle` trues that reservation down to the metered actual
 * (or `release` returns it whole on failure). prisma is faked with an in-memory row whose
 * `updateMany` honours the `spent <= cap - estimate` guard exactly as Postgres would, so these tests
 * exercise the real branch/rollback/settle logic rather than a re-implementation of it.
 */

type IncDec = { increment?: bigint; decrement?: bigint };
const apply = (v: bigint, d?: IncDec): bigint => v + (d?.increment ?? 0n) - (d?.decrement ?? 0n);

const store = vi.hoisted(() => ({
  token: "sjt_test",
  spent: 0n, // JobToken.spentMicros for the single token under test
  day: new Map<string, bigint>(),
  jobCost: 0n, // BuildJob.costMicros charged on settle
}));

vi.mock("@pyre/db", () => ({
  prisma: {
    jobToken: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { token: string; spentMicros?: { lte: bigint } };
        data: { spentMicros?: IncDec };
      }) => {
        if (where.token !== store.token) return { count: 0 };
        if (where.spentMicros?.lte !== undefined && store.spent > where.spentMicros.lte) return { count: 0 };
        store.spent = apply(store.spent, data.spentMicros);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { token: string }; data: { spentMicros?: IncDec } }) => {
        if (where.token !== store.token) throw new Error("unknown token");
        store.spent = apply(store.spent, data.spentMicros);
        return { token: store.token, spentMicros: store.spent };
      },
    },
    dailyComputeSpend: {
      upsert: async ({ where, create }: { where: { day: string }; create: { day: string; micros: bigint } }) => {
        if (!store.day.has(where.day)) store.day.set(where.day, create.micros);
        return { day: where.day, micros: store.day.get(where.day) ?? 0n };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { day: string; micros?: { lte: bigint } };
        data: { micros?: IncDec };
      }) => {
        const cur = store.day.get(where.day) ?? 0n;
        if (where.micros?.lte !== undefined && cur > where.micros.lte) return { count: 0 };
        store.day.set(where.day, apply(cur, data.micros));
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { day: string }; data: { micros?: IncDec } }) => {
        const next = apply(store.day.get(where.day) ?? 0n, data.micros);
        store.day.set(where.day, next);
        return { day: where.day, micros: next };
      },
    },
    buildJob: {
      updateMany: async ({ data }: { where: { id: string }; data: { costMicros?: IncDec } }) => {
        store.jobCost = apply(store.jobCost, data.costMicros);
        return { count: 1 };
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import { HttpError } from "../src/lib/errors.js";
import { costMicrosFor, type Usage } from "../src/lib/pricing.js";
import { reserveBudget } from "../src/proxy/anthropic.js";

const MODEL = MODELS.ROUTINE;
const BODY_BYTES = 64;
const CEILING = BigInt(GLOBAL_DAILY_COMPUTE_CEILING_USD) * 1_000_000n;
const today = (): string => new Date().toISOString().slice(0, 10);

const makeToken = (budgetMicros: bigint): JobToken => ({
  token: store.token,
  jobId: "job_test",
  appId: "app_test",
  budgetMicros,
  spentMicros: 0n,
  expiresAt: new Date(Date.now() + 60_000),
  revoked: false,
});

const reset = (): void => {
  store.spent = 0n;
  store.day.clear();
  store.jobCost = 0n;
};

const caught = async (p: Promise<unknown>): Promise<HttpError> => {
  const err = await p.then(() => null).catch((e: unknown) => e);
  if (!(err instanceof HttpError)) throw new Error(`expected an HttpError, got ${String(err)}`);
  return err;
};

/**
 * The worst-case cost reserveBudget commits for one BODY_BYTES request at MODEL. Discovered
 * empirically (reserve once against an effectively unlimited budget, read what landed) so the test
 * stays correct if the pricing table changes.
 */
let ESTIMATE = 0n;
beforeEach(async () => {
  reset();
  await reserveBudget(makeToken(CEILING * 100n), MODEL, BODY_BYTES);
  ESTIMATE = store.spent;
  reset();
});

describe("reserveBudget", () => {
  it("reserves a positive worst-case estimate up front", () => {
    expect(ESTIMATE).toBeGreaterThan(0n);
  });

  it("blocks a token that has no budget — an app that earned nothing cannot spend", async () => {
    const err = await caught(reserveBudget(makeToken(0n), MODEL, BODY_BYTES));
    expect(err.status).toBe(402);
    expect(err.message).toBe("budget_exhausted");
    expect(store.spent).toBe(0n);
  });

  it("blocks when the budget is below the request's worst-case cost, not its eventual actual", async () => {
    const err = await caught(reserveBudget(makeToken(ESTIMATE - 1n), MODEL, BODY_BYTES));
    expect(err.status).toBe(402);
    expect(store.spent).toBe(0n);
  });

  it("admits exactly one worst-case request per estimate of budget and blocks the next", async () => {
    const token = makeToken(ESTIMATE); // room for exactly one reservation
    const first = await reserveBudget(token, MODEL, BODY_BYTES);
    expect(store.spent).toBe(ESTIMATE);

    const err = await caught(reserveBudget(token, MODEL, BODY_BYTES));
    expect(err.status).toBe(402);
    expect(store.spent).toBe(ESTIMATE); // the rejected reserve changed nothing

    await first.release();
  });

  it("settles a completed request down to its actual metered cost, freeing the over-estimate", async () => {
    const usage: Usage = { inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const actual = costMicrosFor(MODEL, usage);
    expect(actual).toBeLessThan(ESTIMATE); // a cheap call must reserve more than it uses

    const r = await reserveBudget(makeToken(CEILING), MODEL, BODY_BYTES);
    expect(store.spent).toBe(ESTIMATE); // worst case held while in flight
    await r.settle(MODEL, usage);
    expect(store.spent).toBe(actual); // trued down to what was really used
    expect(store.jobCost).toBe(actual); // BuildJob.costMicros charged the real amount
    expect(store.day.get(today())).toBe(actual); // daily counter reflects only the actual
  });

  it("releases the whole estimate when a request never spends", async () => {
    const r = await reserveBudget(makeToken(CEILING), MODEL, BODY_BYTES);
    expect(store.spent).toBe(ESTIMATE);
    await r.release();
    expect(store.spent).toBe(0n);
    expect(store.jobCost).toBe(0n);
    expect(store.day.get(today())).toBe(0n);
  });

  it("blocks at the global daily ceiling and rolls back only the token — the ceiling never leaks", async () => {
    store.day.set(today(), CEILING); // ceiling already reached by other apps
    const err = await caught(reserveBudget(makeToken(CEILING), MODEL, BODY_BYTES));
    expect(err.status).toBe(429);
    expect(err.message).toBe("daily_compute_ceiling");
    expect(store.spent).toBe(0n); // token reservation rolled back
    expect(store.day.get(today())).toBe(CEILING); // daily counter untouched, not decremented below the cap
  });
});
