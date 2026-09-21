import { big, prisma, type App, type JobStage } from "@pyre/db";
import { ITERATION_BUDGET_USD, MIN_BUILD_BUDGET_USD, PLATFORM_PROPOSAL_QUORUM_BPS, PLATFORM_PROPOSAL_STALE_DAYS, PONS_TOTAL_SUPPLY, bps, type BuildJobData } from "@pyre/shared";
import { Worker } from "bullmq";
import { z } from "zod";
import { dailyComputeRemaining } from "../lib/compute.js";
import { checkMilestones } from "../lib/milestones.js";
import { publishEvent, publishGlobal } from "../lib/publishEvent.js";
import { queues, type WorkerContext } from "../lib/queues.js";
import { buildsPaused } from "../lib/settings.js";
import { audit } from "../lib/audit.js";
import { withLock } from "../lib/lock.js";

const SchedulerJob = z.object({ appId: z.string().optional(), kind: z.string().optional() }).default({});

const ITERATE_EVERY_MS = 6 * 60 * 60_000;
const MVP_RETRY_AFTER_MS = 60 * 60_000;
const MICROS = 1_000_000n;
const MIN_ITER = BigInt(ITERATION_BUDGET_USD.MIN) * MICROS;
const MAX_ITER = BigInt(ITERATION_BUDGET_USD.MAX) * MICROS;
const DEFAULT_ITER = BigInt(ITERATION_BUDGET_USD.DEFAULT) * MICROS;
const MIN_BUILD = BigInt(MIN_BUILD_BUDGET_USD) * MICROS;
/** BullMQ priority for apps with no $PYRE stake (lower number = sooner). */
const UNSTAKED_PRIORITY = 1000;
/** One tick walks every LIVE app with a few queries each; the schedule is 60s. */
const TICK_LOCK_TTL_SECONDS = 120;
/** Fed to the agent when an iteration has no holder tasks queued. */
const NO_TASKS_INSTRUCTION =
  "No holder tasks are queued. Improve the product: fix rough edges, tighten the core flow, improve conversion toward the monetization model, and expand test coverage.";

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Create a BuildJob row, mark its tasks SCHEDULED, enqueue it and announce it on the feed. */
export const enqueueBuildJob = async (p: {
  app: Pick<App, "id" | "slug">;
  stage: JobStage;
  budgetMicros: bigint;
  taskIds?: string[];
  instruction?: string;
  prNumber?: number;
  priority?: number;
  appData?: Partial<Pick<App, "firstBuildAt">>;
}): Promise<string> => {
  const taskIds = p.taskIds ?? [];
  const row = await prisma.$transaction(async (tx) => {
    const job = await tx.buildJob.create({
      data: {
        appId: p.app.id,
        stage: p.stage,
        budgetMicros: p.budgetMicros,
        taskIds,
        instruction: p.instruction ?? null,
        prNumber: p.prNumber ?? null,
      },
    });
    if (taskIds.length > 0) {
      await tx.promptQueueItem.updateMany({ where: { id: { in: taskIds } }, data: { status: "SCHEDULED", jobId: job.id } });
    }
    if (p.appData && Object.keys(p.appData).length > 0) await tx.app.update({ where: { id: p.app.id }, data: p.appData });
    return job;
  });
  const data: BuildJobData = {
    jobId: row.id,
    appId: p.app.id,
    stage: p.stage,
    budgetUsd: Math.max(0.01, Number(p.budgetMicros) / 1e6),
    taskIds,
    instruction: p.instruction,
    prNumber: p.prNumber,
  };
  await queues.build.add("build", data, { jobId: `build-${row.id}`, priority: p.priority ?? UNSTAKED_PRIORITY });
  await publishEvent(p.app.id, { type: "JOB_QUEUED", stage: p.stage, budgetUsd: Number(p.budgetMicros) / 1e6 }, row.id);
  return row.id;
};

/** What the scheduler decided to do with one app this tick. */
export type BuildDecision =
  | { kind: "none" }
  | { kind: "dormant"; reason: string }
  | { kind: "build"; stage: JobStage; budgetMicros: bigint; taskIds: string[]; instruction?: string; firstBuild: boolean };

export interface DecisionInput {
  app: Pick<App, "id" | "budgetMicros" | "pendingRevenueMicros" | "firstBuildAt" | "liveVersion">;
  /** A QUEUED or RUNNING BuildJob already exists for this app. */
  hasActiveJob: boolean;
  paused: boolean;
  /** Platform daily compute ceiling still has room for one iteration. */
  computeOk: boolean;
  /** Any BuildJob row exists: without one an MVP retry is due immediately. */
  hasPriorJob: boolean;
  /** `finishedAt` of the newest BuildJob, null when it never finished. */
  lastJobFinishedAt: Date | null;
  /** `error` of the newest BuildJob, fed back into the MVP retry prompt. */
  lastJobError: string | null;
  /** `createdAt` of the newest ITERATE job, null when there is none. */
  lastIterateAt: Date | null;
  openTaskIds: string[];
  now: number;
}

/**
 * The per-app scheduling decision, pure so the money gates are testable. Branch order
 * is load-bearing: active/paused, first build, MVP retry, then iteration.
 *
 * Dormancy is gated only on budget and pending revenue — the daily compute ceiling
 * (`computeOk`) blocks building but never marks an app dormant, and a paused platform
 * decides nothing at all.
 */
export const nextBuildDecision = (input: DecisionInput): BuildDecision => {
  const { app } = input;
  if (input.hasActiveJob || input.paused) return { kind: "none" };

  if (!app.firstBuildAt) {
    if (app.budgetMicros >= MIN_BUILD && input.computeOk) {
      return { kind: "build", stage: "MVP", budgetMicros: min(app.budgetMicros, MAX_ITER), taskIds: [], firstBuild: true };
    }
    return { kind: "none" };
  }

  if (app.liveVersion === 0) {
    // MVP attempted but never deployed: retry hourly while there is budget, feeding back the last error.
    const retryDue =
      !input.hasPriorJob ||
      (input.lastJobFinishedAt !== null && input.now - input.lastJobFinishedAt.getTime() > MVP_RETRY_AFTER_MS);
    if (retryDue && app.budgetMicros >= MIN_ITER && input.computeOk) {
      return {
        kind: "build",
        stage: "MVP",
        budgetMicros: min(app.budgetMicros, MAX_ITER),
        taskIds: [],
        instruction: input.lastJobError ? `The previous build attempt failed with:\n${input.lastJobError.slice(0, 2000)}` : undefined,
        firstBuild: false,
      };
    }
    if (app.budgetMicros < MIN_ITER && app.pendingRevenueMicros === 0n) {
      return { kind: "dormant", reason: "Build budget exhausted before the MVP shipped" };
    }
    return { kind: "none" };
  }

  if (app.budgetMicros >= MIN_ITER) {
    if (!input.computeOk) return { kind: "none" };
    const due = input.lastIterateAt === null || input.now - input.lastIterateAt.getTime() > ITERATE_EVERY_MS;
    if (input.openTaskIds.length === 0 && !due) return { kind: "none" };
    return {
      kind: "build",
      stage: "ITERATE",
      budgetMicros: min(app.budgetMicros, DEFAULT_ITER),
      taskIds: input.openTaskIds,
      instruction: input.openTaskIds.length === 0 ? NO_TASKS_INSTRUCTION : undefined,
      firstBuild: false,
    };
  }
  if (app.pendingRevenueMicros === 0n) return { kind: "dormant", reason: "Build budget exhausted" };
  return { kind: "none" };
};

type TickApp = Pick<App, "id" | "slug" | "budgetMicros" | "pendingRevenueMicros" | "firstBuildAt" | "liveVersion">;

/**
 * Loads only the rows the app's branch actually needs: the newest job for an
 * undeployed app, open tasks and the last iteration for a deployed one.
 */
const decisionInput = async (app: TickApp, flags: { paused: boolean; computeOk: boolean }): Promise<DecisionInput> => {
  const retrying = app.firstBuildAt !== null && app.liveVersion === 0;
  const iterating = app.firstBuildAt !== null && app.liveVersion > 0 && app.budgetMicros >= MIN_ITER;
  const lastJob = retrying
    ? await prisma.buildJob.findFirst({ where: { appId: app.id }, orderBy: { createdAt: "desc" }, select: { finishedAt: true, error: true } })
    : null;
  const open = iterating
    ? await prisma.promptQueueItem.findMany({
        where: { appId: app.id, status: "OPEN" },
        orderBy: [{ weight: "desc" }, { createdAt: "asc" }],
        take: 3,
        select: { id: true },
      })
    : [];
  const lastIterate = iterating
    ? await prisma.buildJob.findFirst({ where: { appId: app.id, stage: "ITERATE" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } })
    : null;
  return {
    app,
    hasActiveJob: false,
    paused: flags.paused,
    computeOk: flags.computeOk,
    hasPriorJob: lastJob !== null,
    lastJobFinishedAt: lastJob?.finishedAt ?? null,
    lastJobError: lastJob?.error ?? null,
    lastIterateAt: lastIterate?.createdAt ?? null,
    openTaskIds: open.map((o) => o.id),
    now: Date.now(),
  };
};

/** One scheduling pass over LIVE apps (or a single app), guarded so two runners cannot double-enqueue. */
export const scheduleTick = async (ctx: WorkerContext, appId?: string): Promise<void> => {
  const key = appId ? `lock:scheduler:app:${appId}` : "lock:scheduler:tick";
  const pass = await withLock(ctx.redis, key, TICK_LOCK_TTL_SECONDS, () => schedulePass(ctx, appId));
  if (!pass.acquired) ctx.log.info({ appId, key }, "scheduler tick skipped; lock held by another runner");
};

const schedulePass = async (ctx: WorkerContext, appId?: string): Promise<void> => {
  const apps = await prisma.app.findMany({
    where: { status: "LIVE", ...(appId ? { id: appId } : {}) },
    include: { jobs: { where: { status: { in: ["QUEUED", "RUNNING"] } }, take: 1, select: { id: true } } },
  });
  if (apps.length === 0) return;

  const stakes = await prisma.pyreStake.groupBy({
    by: ["appId"],
    where: { withdrawnAt: null, appId: { in: apps.map((a) => a.id) } },
    _sum: { amount: true },
  });
  const priority: Record<string, number> = {};
  stakes
    .map((s) => ({ appId: s.appId, staked: big(s._sum.amount) }))
    .filter((s) => s.staked > 0n)
    .sort((a, b) => (a.staked > b.staked ? -1 : 1))
    .forEach((s, i) => {
      priority[s.appId] = i + 1;
    });

  const paused = await buildsPaused();
  const daily = await dailyComputeRemaining();
  const computeOk = daily >= MIN_ITER;
  if (!computeOk) ctx.log.warn({ remainingMicros: daily.toString() }, "scheduler: daily compute ceiling reached");

  for (const app of apps) {
    try {
      await checkMilestones(app.id);
      if (app.jobs.length > 0 || paused) continue;
      const decision = nextBuildDecision(await decisionInput(app, { paused, computeOk }));
      if (decision.kind === "dormant") {
        await markDormant(app.id, decision.reason);
      } else if (decision.kind === "build") {
        await enqueueBuildJob({
          app,
          priority: priority[app.id] ?? UNSTAKED_PRIORITY,
          stage: decision.stage,
          budgetMicros: decision.budgetMicros,
          taskIds: decision.taskIds,
          instruction: decision.instruction,
          appData: decision.firstBuild ? { firstBuildAt: new Date() } : undefined,
        });
      }
    } catch (e) {
      ctx.log.error({ err: e, appId: app.id }, "scheduler: app pass failed");
    }
  }
};

const markDormant = async (appId: string, reason: string): Promise<void> => {
  await prisma.app.update({ where: { id: appId }, data: { status: "DORMANT" } });
  await audit({
    actor: "worker:scheduler",
    action: "APP_STATUS",
    targetType: "App",
    targetId: appId,
    meta: { from: "LIVE", to: "DORMANT", reason },
  });
  await publishEvent(appId, { type: "DORMANT", reason });
  await publishGlobal(appId);
};

/** Capped $PYRE vote weight (base units) a proposal must reach to survive auto-close — the 10% quorum. */
const PLATFORM_PROPOSAL_QUORUM = bps(PONS_TOTAL_SUPPLY, PLATFORM_PROPOSAL_QUORUM_BPS);
/** A stale-proposal sweep is a handful of aggregate queries; a short lock keeps two runners from racing. */
const CLOSE_STALE_LOCK_TTL_SECONDS = 120;

/**
 * Once-daily sweep: OPEN proposals older than the stale window whose summed capped vote weight never
 * reached quorum are auto-declined so the governance board stays current. Race-safe via a status guard.
 */
export const closeStaleProposals = async (ctx: WorkerContext): Promise<void> => {
  const cutoff = new Date(Date.now() - PLATFORM_PROPOSAL_STALE_DAYS * 24 * 60 * 60_000);
  const stale = await prisma.proposal.findMany({
    where: { status: "OPEN", createdAt: { lt: cutoff } },
    select: { id: true },
  });
  if (stale.length === 0) return;
  const weights = await prisma.proposalVote.groupBy({
    by: ["proposalId"],
    where: { proposalId: { in: stale.map((p) => p.id) } },
    _sum: { weight: true },
  });
  const weightByProposal: Record<string, bigint> = {};
  for (const w of weights) weightByProposal[w.proposalId] = big(w._sum.weight);
  for (const proposal of stale) {
    if ((weightByProposal[proposal.id] ?? 0n) >= PLATFORM_PROPOSAL_QUORUM) continue;
    try {
      const fresh = await prisma.proposalVote.aggregate({
        where: { proposalId: proposal.id },
        _sum: { weight: true },
      });
      if (big(fresh._sum.weight) >= PLATFORM_PROPOSAL_QUORUM) continue;
      const res = await prisma.proposal.updateMany({
        where: { id: proposal.id, status: "OPEN" },
        data: { status: "DECLINED", ownerNote: "Auto-closed: stale, did not reach quorum." },
      });
      if (res.count === 0) continue;
      await audit({
        actor: "worker:scheduler",
        action: "PROPOSAL_STATUS",
        targetType: "Proposal",
        targetId: proposal.id,
        meta: { from: "OPEN", to: "DECLINED", reason: "stale: did not reach quorum" },
      });
    } catch (e) {
      ctx.log.error({ err: e, proposalId: proposal.id }, "scheduler: auto-close stale proposal failed");
    }
  }
};

export const registerSchedulerWorker = async (ctx: WorkerContext): Promise<Worker[]> => {
  const worker = new Worker(
    "scheduler",
    async (job) => {
      const data = SchedulerJob.parse(job.data ?? {});
      if (data.kind === "closeStale") {
        const pass = await withLock(ctx.redis, "lock:scheduler:closeStale", CLOSE_STALE_LOCK_TTL_SECONDS, () =>
          closeStaleProposals(ctx),
        );
        if (!pass.acquired) ctx.log.info("closeStale sweep skipped; lock held by another runner");
        return;
      }
      await scheduleTick(ctx, data.appId);
    },
    { connection: ctx.redis, concurrency: 1 },
  );
  worker.on("failed", (job, err) => ctx.log.error({ jobId: job?.id, err }, "scheduler job failed"));
  await queues.scheduler.upsertJobScheduler(
    "scheduler:closeStale",
    { every: 24 * 60 * 60_000 },
    { name: "closeStale", data: { kind: "closeStale" } },
  );
  await queues.scheduler.upsertJobScheduler("scheduler:tick", { every: 60_000 }, { name: "tick", data: {} });
  return [worker];
};
