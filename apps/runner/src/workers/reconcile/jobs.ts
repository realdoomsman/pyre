import { prisma } from "@pyre/db";
import type { BuildJobData } from "@pyre/shared";
import { Sandbox } from "e2b";
import type { Logger } from "pino";
import { SANDBOX_TIMEOUT_MS } from "../../build/engine.js";
import { env } from "../../env.js";
import { audit } from "../../lib/audit.js";
import { debitAppBudget } from "../../lib/compute.js";
import { publishEvent, publishGlobal } from "../../lib/publishEvent.js";
import { queues, type WorkerContext } from "../../lib/queues.js";
import { emptyOutcome, type CheckOutcome, type Finding } from "./report.js";

/** A build cannot outlive its sandbox; past the hard wall plus this grace it is dead. */
const REAP_GRACE_MS = 5 * 60_000;
/** Ignore freshly enqueued rows: BullMQ `add` and the row write are not one transaction. */
const QUEUED_GRACE_MS = 2 * 60_000;
/** A QUEUED row this old has missed too many cycles to be worth re-enqueueing. */
const QUEUED_STALE_MS = 6 * 60 * 60_000;

export interface SettledJob {
  jobId: string;
  appId: string;
  stage: string;
  costMicros: bigint;
  reopenedTasks: number;
  sandboxKilled: boolean;
}

/**
 * Settles a `RUNNING` BuildJob whose runner is gone: FAILED with a real error, the
 * actual agent spend debited, the job token revoked, its sandbox killed and its
 * consumed queue items reopened. Returns null when the row is no longer RUNNING
 * (another reaper or the owning runner got there first).
 */
export const settleAbandonedJob = async (jobId: string, reason: string, log: Logger): Promise<SettledJob | null> => {
  const job = await prisma.buildJob.findUnique({
    where: { id: jobId },
    select: { id: true, appId: true, stage: true, status: true, taskIds: true, sandboxId: true, startedAt: true },
  });
  if (!job) return null;
  if (job.status !== "RUNNING") {
    log.info({ jobId, status: job.status }, "job already settled; nothing to reap");
    return null;
  }
  const token = await prisma.jobToken.findUnique({ where: { jobId }, select: { token: true, spentMicros: true } });
  const costMicros = token?.spentMicros ?? 0n;

  const settled = await prisma.$transaction(async (tx) => {
    // Guarded on status so two reapers cannot both settle (and both debit) the job.
    const claimed = await tx.buildJob.updateMany({
      where: { id: jobId, status: "RUNNING" },
      data: { status: "FAILED", error: reason.slice(0, 2000), costMicros, finishedAt: new Date() },
    });
    if (claimed.count === 0) return null;
    await tx.jobToken.updateMany({ where: { jobId }, data: { revoked: true } });
    const reopened =
      job.taskIds.length > 0
        ? await tx.promptQueueItem.updateMany({
            where: { id: { in: job.taskIds }, status: "SCHEDULED" },
            data: { status: "OPEN", jobId: null },
          })
        : { count: 0 };
    return { reopened: reopened.count };
  });
  if (!settled) {
    log.info({ jobId }, "job settled concurrently; skipping reap");
    return null;
  }

  await debitAppBudget(job.appId, costMicros, "BuildJob", job.id, `reaped ${job.stage}`);

  let sandboxKilled = false;
  if (job.sandboxId) {
    sandboxKilled = await Sandbox.kill(job.sandboxId, { apiKey: env.E2B_API_KEY }).catch((err: unknown) => {
      log.warn({ err, sandboxId: job.sandboxId }, "sandbox kill failed while reaping");
      return false;
    });
  }

  await publishEvent(job.appId, { type: "JOB_FAILED", costUsd: Number(costMicros) / 1e6, error: reason }, job.id);
  await publishGlobal(job.appId);
  await audit({
    actor: "worker:reconcile",
    action: "REAP_JOB",
    targetType: "BuildJob",
    targetId: job.id,
    meta: {
      appId: job.appId,
      stage: job.stage,
      reason,
      costMicros,
      startedAt: job.startedAt,
      sandboxId: job.sandboxId,
      sandboxKilled,
      reopenedTasks: settled.reopened,
      tokenRevoked: token !== null,
    },
  });
  log.warn(
    { jobId: job.id, appId: job.appId, stage: job.stage, costMicros, sandboxKilled, reopenedTasks: settled.reopened },
    "reaped abandoned build job",
  );
  return {
    jobId: job.id,
    appId: job.appId,
    stage: job.stage,
    costMicros,
    reopenedTasks: settled.reopened,
    sandboxKilled,
  };
};

/** QUEUED rows whose BullMQ job vanished: re-enqueue, cancel (app gone) or fail (too old). */
const recoverQueued = async (ctx: WorkerContext, outcome: CheckOutcome): Promise<void> => {
  const rows = await prisma.buildJob.findMany({
    where: { status: "QUEUED", createdAt: { lt: new Date(Date.now() - QUEUED_GRACE_MS) } },
    select: {
      id: true,
      appId: true,
      stage: true,
      budgetMicros: true,
      taskIds: true,
      instruction: true,
      prNumber: true,
      createdAt: true,
      app: { select: { status: true } },
    },
  });
  outcome.checked += rows.length;
  for (const row of rows) {
    if (await queues.build.getJob(`build-${row.id}`)) continue;
    outcome.drifted++;
    const finding: Finding = { code: "QUEUED_WITHOUT_BULLMQ_JOB", detail: "", jobId: row.id, appId: row.appId, stage: row.stage };
    if (row.app.status !== "LIVE") {
      await prisma.buildJob.update({
        where: { id: row.id },
        data: { status: "CANCELLED", error: `app is ${row.app.status}`, finishedAt: new Date() },
      });
      finding.detail = `cancelled: app is ${row.app.status}`;
    } else if (Date.now() - row.createdAt.getTime() > QUEUED_STALE_MS) {
      await prisma.buildJob.update({
        where: { id: row.id },
        data: { status: "FAILED", error: "queued job was never picked up by a runner", finishedAt: new Date() },
      });
      await publishEvent(row.appId, { type: "JOB_FAILED", costUsd: 0, error: "queued job was never picked up by a runner" }, row.id);
      finding.detail = "failed: queued longer than 6h with no BullMQ job";
    } else {
      const data: BuildJobData = {
        jobId: row.id,
        appId: row.appId,
        stage: row.stage,
        budgetUsd: Math.max(0.01, Number(row.budgetMicros) / 1e6),
        taskIds: row.taskIds,
        instruction: row.instruction ?? undefined,
        prNumber: row.prNumber ?? undefined,
      };
      await queues.build.add("build", data, { jobId: `build-${row.id}` });
      finding.detail = "re-enqueued on the build queue";
    }
    outcome.repaired++;
    outcome.findings.push(finding);
    ctx.log.warn({ ...finding, worker: "reconcile" }, "recovered queued build job");
  }
};

/**
 * JOBS: settle builds whose runner died, and recover QUEUED rows that lost their
 * BullMQ job. Together these are what makes a runner crash survivable.
 */
export const checkJobs = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const log = ctx.log.child({ worker: "reconcile", check: "JOBS" });
  const cutoff = new Date(Date.now() - SANDBOX_TIMEOUT_MS - REAP_GRACE_MS);
  const stuck = await prisma.buildJob.findMany({
    where: {
      status: "RUNNING",
      OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true, appId: true, startedAt: true },
    orderBy: { startedAt: "asc" },
  });
  outcome.checked += stuck.length;
  for (const row of stuck) {
    outcome.drifted++;
    const ageMs = Date.now() - (row.startedAt ?? cutoff).getTime();
    const reason = `build abandoned: no runner reported progress for ${Math.round(ageMs / 60_000)} minutes (past the ${SANDBOX_TIMEOUT_MS / 60_000}-minute sandbox wall); reaped by reconcile`;
    const settled = await settleAbandonedJob(row.id, reason, log);
    if (!settled) continue;
    outcome.repaired++;
    outcome.findings.push({
      code: "REAPED_RUNNING_JOB",
      detail: `settled after ${Math.round(ageMs / 60_000)}m; debited ${settled.costMicros.toString()} micros`,
      jobId: settled.jobId,
      appId: settled.appId,
      stage: settled.stage,
      sandboxKilled: settled.sandboxKilled,
      reopenedTasks: settled.reopenedTasks,
    });
  }
  await recoverQueued(ctx, outcome);
  return outcome;
};
