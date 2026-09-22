import { GLOBAL_DAILY_COMPUTE_CEILING_USD, ITERATION_BUDGET_USD, MIN_BUILD_BUDGET_USD } from "@pyre/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "@pyre/db";

/**
 * Budget gating: what the scheduler is allowed to spend, and when an app goes dormant. These are
 * the rules that decide whether a coin's fees turn into builds, so each branch is pinned with the
 * boundary value that separates it from its neighbour.
 *
 * `queues.js` opens a live Redis connection at import, so it and prisma are faked. Nothing here
 * touches a socket.
 */

let dailySpentMicros: bigint | null = null;

vi.mock("../src/lib/queues.js", () => ({
  createRedis: () => ({ on: () => undefined }),
  queues: { build: { add: async () => ({ id: "job" }) }, scheduler: { upsertJobScheduler: async () => undefined } },
  QUEUE_NAMES: [],
  closeQueues: async () => undefined,
}));
vi.mock("@pyre/db", () => ({
  prisma: {
    dailyComputeSpend: {
      findUnique: async () => (dailySpentMicros === null ? null : { day: "2026-09-18", micros: dailySpentMicros }),
      upsert: async () => ({}),
    },
    platformSetting: { findUnique: async () => null },
    app: { findMany: async () => [], update: async () => ({}) },
    buildJob: { findFirst: async () => null },
    promptQueueItem: { findMany: async () => [] },
  },
}));

import { dailyComputeRemaining } from "../src/lib/compute.js";
import { nextBuildDecision, type DecisionInput } from "../src/workers/scheduler.js";

const MICROS = 1_000_000n;
const MIN_ITER = BigInt(ITERATION_BUDGET_USD.MIN) * MICROS;
const MAX_ITER = BigInt(ITERATION_BUDGET_USD.MAX) * MICROS;
const DEFAULT_ITER = BigInt(ITERATION_BUDGET_USD.DEFAULT) * MICROS;
const MIN_BUILD = BigInt(MIN_BUILD_BUDGET_USD) * MICROS;
const CEILING = BigInt(GLOBAL_DAILY_COMPUTE_CEILING_USD) * MICROS;
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const HOUR = 3_600_000;

type DecisionApp = DecisionInput["app"];

/** A LIVE app that has shipped an MVP and has budget; each test perturbs one field. */
const app = (over: Partial<DecisionApp> = {}): DecisionApp => ({
  id: "app_1",
  budgetMicros: 100n * MICROS,
  firstBuildAt: new Date(NOW - 30 * 24 * HOUR),
  liveVersion: 3,
  ...(over as Partial<App>),
});

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  app: app(),
  hasActiveJob: false,
  paused: false,
  computeOk: true,
  hasPriorJob: true,
  lastJobFinishedAt: new Date(NOW - 2 * HOUR),
  lastJobError: null,
  lastIterateAt: new Date(NOW - 7 * HOUR),
  openTaskIds: [],
  now: NOW,
  ...over,
});

describe("first build threshold", () => {
  const fresh = (budgetMicros: bigint): DecisionInput => input({ app: app({ firstBuildAt: null, liveVersion: 0, budgetMicros }) });

  it("waits until the accrued budget reaches MIN_BUILD_BUDGET_USD", () => {
    expect(nextBuildDecision(fresh(MIN_BUILD - 1n)).kind).toBe("none");
    expect(nextBuildDecision(fresh(MIN_BUILD))).toEqual({
      kind: "build",
      stage: "MVP",
      budgetMicros: MIN_BUILD,
      taskIds: [],
      firstBuild: true,
    });
  });

  it("does not fall back to the cheaper iteration floor for the first build", () => {
    // $10 of fees is enough for an iteration but must not trigger the MVP build.
    expect(nextBuildDecision(fresh(MIN_ITER)).kind).toBe("none");
    expect(MIN_ITER).toBeLessThan(MIN_BUILD);
  });

  it("caps the first build at the per-iteration maximum even with a huge budget", () => {
    const decision = nextBuildDecision(fresh(10_000n * MICROS));
    expect(decision).toMatchObject({ kind: "build", stage: "MVP", budgetMicros: MAX_ITER, firstBuild: true });
  });

  it("never marks a pre-MVP app dormant, however empty its budget", () => {
    expect(nextBuildDecision(fresh(0n)).kind).toBe("none");
    expect(nextBuildDecision(input({ app: app({ firstBuildAt: null, liveVersion: 0, budgetMicros: 0n }) })).kind).toBe("none");
  });

  it("is blocked by the daily compute ceiling without going dormant", () => {
    expect(nextBuildDecision({ ...fresh(MIN_BUILD), computeOk: false }).kind).toBe("none");
  });
});

describe("iteration threshold", () => {
  it("requires ITERATION_BUDGET_USD.MIN and no more", () => {
    expect(nextBuildDecision(input({ app: app({ budgetMicros: MIN_ITER - 1n }) })).kind).toBe("dormant");
    expect(nextBuildDecision(input({ app: app({ budgetMicros: MIN_ITER }) }))).toMatchObject({
      kind: "build",
      stage: "ITERATE",
      budgetMicros: MIN_ITER,
      firstBuild: false,
    });
  });

  it("spends the default iteration budget, not the whole balance", () => {
    const decision = nextBuildDecision(input({ app: app({ budgetMicros: 5_000n * MICROS }) }));
    expect(decision).toMatchObject({ kind: "build", budgetMicros: DEFAULT_ITER });
    expect(DEFAULT_ITER).toBeLessThan(5_000n * MICROS);
  });

  it("runs on the 6-hour cadence when no holder tasks are queued", () => {
    const justRan = input({ lastIterateAt: new Date(NOW - 5 * HOUR) });
    expect(nextBuildDecision(justRan).kind).toBe("none");
    expect(nextBuildDecision(input({ lastIterateAt: new Date(NOW - 6 * HOUR - 1) })).kind).toBe("build");
    // Exactly six hours is not yet due; the comparison is strict.
    expect(nextBuildDecision(input({ lastIterateAt: new Date(NOW - 6 * HOUR) })).kind).toBe("none");
    expect(nextBuildDecision(input({ lastIterateAt: null })).kind).toBe("build");
  });

  it("jumps the cadence when holders have queued tasks, and passes them through", () => {
    const decision = nextBuildDecision(input({ lastIterateAt: new Date(NOW - 1 * HOUR), openTaskIds: ["t1", "t2"] }));
    expect(decision).toMatchObject({ kind: "build", stage: "ITERATE", taskIds: ["t1", "t2"] });
    if (decision.kind === "build") expect(decision.instruction).toBeUndefined();
  });

  it("substitutes a self-improvement instruction only when the queue is empty", () => {
    const empty = nextBuildDecision(input({ openTaskIds: [] }));
    expect(empty.kind).toBe("build");
    if (empty.kind === "build") {
      expect(empty.instruction).toContain("No holder tasks are queued");
      expect(empty.taskIds).toEqual([]);
    }
    const withTasks = nextBuildDecision(input({ openTaskIds: ["t1"] }));
    if (withTasks.kind === "build") expect(withTasks.instruction).toBeUndefined();
  });
});

describe("dormancy", () => {
  it("goes dormant when the budget is spent", () => {
    expect(nextBuildDecision(input({ app: app({ budgetMicros: 0n }) }))).toEqual({
      kind: "dormant",
      reason: "Build budget exhausted",
    });
  });

  it("builds again the moment the budget clears the iteration floor", () => {
    expect(nextBuildDecision(input({ app: app({ budgetMicros: MIN_ITER - 1n }) })).kind).toBe("dormant");
    expect(nextBuildDecision(input({ app: app({ budgetMicros: MIN_ITER }) })).kind).toBe("build");
  });

  it("uses a distinct reason when the MVP never shipped", () => {
    expect(
      nextBuildDecision(input({ app: app({ liveVersion: 0, budgetMicros: MIN_ITER - 1n }), lastJobFinishedAt: new Date(NOW - 2 * HOUR) })),
    ).toEqual({ kind: "dormant", reason: "Build budget exhausted before the MVP shipped" });
  });

  it("still fires when the platform is over its daily compute ceiling", () => {
    // Dormancy is a money fact, not a capacity fact: an app with no budget is dormant either way.
    expect(nextBuildDecision(input({ app: app({ budgetMicros: 0n }), computeOk: false })).kind).toBe("dormant");
  });

  it("decides nothing at all while builds are paused or a job is already running", () => {
    expect(nextBuildDecision(input({ app: app({ budgetMicros: 0n }), paused: true })).kind).toBe("none");
    expect(nextBuildDecision(input({ app: app({ budgetMicros: 0n }), hasActiveJob: true })).kind).toBe("none");
    expect(nextBuildDecision(input({ paused: true })).kind).toBe("none");
    expect(nextBuildDecision(input({ hasActiveJob: true })).kind).toBe("none");
  });
});

describe("MVP retry", () => {
  const undeployed = (over: Partial<DecisionInput> = {}): DecisionInput =>
    input({ app: app({ liveVersion: 0, budgetMicros: 100n * MICROS }), ...over });

  it("retries hourly after the last attempt finished", () => {
    expect(nextBuildDecision(undeployed({ lastJobFinishedAt: new Date(NOW - 59 * 60_000) })).kind).toBe("none");
    expect(nextBuildDecision(undeployed({ lastJobFinishedAt: new Date(NOW - 61 * 60_000) })).kind).toBe("build");
  });

  it("retries immediately when no job has ever run, but waits on one still running", () => {
    expect(nextBuildDecision(undeployed({ hasPriorJob: false, lastJobFinishedAt: null })).kind).toBe("build");
    // A prior job that never finished means it is still running: no retry, no dormancy.
    expect(nextBuildDecision(undeployed({ hasPriorJob: true, lastJobFinishedAt: null })).kind).toBe("none");
  });

  it("feeds the previous failure back to the agent, truncated", () => {
    const decision = nextBuildDecision(undeployed({ lastJobError: "TypeError: x is not a function" }));
    expect(decision).toMatchObject({ kind: "build", stage: "MVP", firstBuild: false });
    if (decision.kind === "build") {
      expect(decision.instruction).toBe("The previous build attempt failed with:\nTypeError: x is not a function");
    }
    const long = nextBuildDecision(undeployed({ lastJobError: "e".repeat(5_000) }));
    if (long.kind === "build") expect(long.instruction?.length).toBe("The previous build attempt failed with:\n".length + 2_000);
  });

  it("marks a retried MVP as a retry, not a first build", () => {
    const decision = nextBuildDecision(undeployed({}));
    expect(decision).toMatchObject({ kind: "build", firstBuild: false });
  });
});

describe("dailyComputeRemaining", () => {
  beforeEach(() => {
    dailySpentMicros = null;
  });

  it("is the whole ceiling before anything is spent", async () => {
    expect(await dailyComputeRemaining()).toBe(CEILING);
  });

  it("hits zero exactly at the ceiling, not one call later", async () => {
    dailySpentMicros = CEILING - 1n;
    expect(await dailyComputeRemaining()).toBe(1n);
    dailySpentMicros = CEILING;
    expect(await dailyComputeRemaining()).toBe(0n);
    dailySpentMicros = CEILING + 5_000_000n;
    expect(await dailyComputeRemaining()).toBe(0n);
  });

  it("blocks new work exactly when the remainder can no longer fund one iteration", async () => {
    // The scheduler's gate is `remaining >= MIN_ITER`.
    dailySpentMicros = CEILING - MIN_ITER;
    expect((await dailyComputeRemaining()) >= MIN_ITER).toBe(true);
    dailySpentMicros = CEILING - MIN_ITER + 1n;
    expect((await dailyComputeRemaining()) >= MIN_ITER).toBe(false);
  });

  it("stops every kind of new build once the ceiling is reached", () => {
    const blocked = { computeOk: false };
    expect(nextBuildDecision(input(blocked)).kind).toBe("none");
    expect(nextBuildDecision(input({ ...blocked, openTaskIds: ["t1"] })).kind).toBe("none");
    expect(nextBuildDecision(input({ ...blocked, app: app({ firstBuildAt: null, liveVersion: 0, budgetMicros: MIN_BUILD }) })).kind).toBe(
      "none",
    );
    expect(nextBuildDecision(input({ ...blocked, app: app({ liveVersion: 0 }) })).kind).toBe("none");
  });
});
