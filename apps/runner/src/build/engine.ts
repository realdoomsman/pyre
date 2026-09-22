import { prisma, type App, type BuildJob } from "@pyre/db";
import { AppSpec, ITERATION_BUDGET_USD, type BuildEventPayload } from "@pyre/shared";
import type { Sandbox } from "e2b";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import { models } from "../env.js";
import { addDailyCompute, dailyComputeRemaining, debitAppBudget } from "../lib/compute.js";
import { audit } from "../lib/audit.js";
import { ensureAppRepo } from "../lib/github.js";
import { checkMilestones } from "../lib/milestones.js";
import { publishEvent, publishGlobal } from "../lib/publishEvent.js";
import { queues } from "../lib/queues.js";
import { settleAbandonedJob } from "../workers/reconcile/jobs.js";
import { enqueueBuildJob } from "../workers/scheduler.js";
import { APP_DIR, createSandbox, readText } from "../sandbox/sandbox.js";
import { bootstrapSandbox } from "../sandbox/setup.js";
import { runAgent } from "./agent.js";
import { BundleError, createDeployment } from "./deploy.js";
import { stagePrompt, systemContext, type AgentStage } from "./prompts.js";
import { commitAndPush, stageAndDiff } from "./repo.js";
import { reviewChange } from "./reviewer.js";
import { verifyApp } from "./verify.js";

/** Expected, user-facing failure: the job ends FAILED with this message, no stack. */
export class JobFailure extends Error {}

export const SANDBOX_TIMEOUT_MS = 40 * 60_000;
const TOKEN_TTL_MS = 50 * 60_000;

/**
 * BuildJobs this process is executing right now, keyed by job id. Shutdown drains
 * from here so an interrupted build is settled instead of dangling as RUNNING
 * until the reaper notices.
 */
export const inFlightBuilds = new Map<string, { appId: string; stage: BuildJob["stage"]; startedAt: number }>();

const MAX_TURNS: Record<AgentStage, number> = { MVP: 250, ITERATE: 150, SELF_HEAL: 100 };

const AGENT_STAGE: Record<BuildJob["stage"], AgentStage | null> = {
  SCAFFOLD: "MVP",
  MVP: "MVP",
  ITERATE: "ITERATE",
  SELF_HEAL: "SELF_HEAL",
  DEPLOY: null,
  VERIFY: null,
  PR_REVIEW: null,
};

type Ctx = {
  job: BuildJob;
  app: App;
  spec: AppSpec;
  token: string;
  budgetMicros: bigint;
  agentStage: AgentStage | null;
  model: string;
  startedAt: number;
  log: Logger;
  reviewerCost: bigint;
  summary: string;
  commitSha: string | null;
  deploymentId: string | null;
};

const emit = (ctx: Ctx, payload: BuildEventPayload) => publishEvent(ctx.app.id, payload, ctx.job.id);

const runStages = async (ctx: Ctx, sbx: Sandbox): Promise<void> => {
  const { app, job, spec, log } = ctx;

  await emit(ctx, { type: "STAGE", stage: "SCAFFOLD", status: "START" });
  await bootstrapSandbox(sbx, { repoFullName: app.repoFullName, log });
  await emit(ctx, { type: "STAGE", stage: "SCAFFOLD", status: "DONE" });

  if (ctx.agentStage) {
    await emit(ctx, { type: "STAGE", stage: ctx.agentStage, status: "START" });
    const tasks =
      ctx.agentStage === "ITERATE" && job.taskIds.length > 0
        ? (await prisma.promptQueueItem.findMany({ where: { id: { in: job.taskIds } }, orderBy: { weight: "desc" } })).map(
            (t) => t.text,
          )
        : [];
    if (ctx.agentStage === "ITERATE" && tasks.length === 0 && !job.instruction) {
      throw new JobFailure("iteration has no tasks");
    }
    const manifestText = await readText(sbx, `${APP_DIR}/pyre.manifest.json`).catch(() => "{}");
    const outcome = await runAgent({
      sbx,
      jobId: job.id,
      appId: app.id,
      token: ctx.token,
      model: ctx.model,
      budgetMicros: ctx.budgetMicros,
      maxTurns: MAX_TURNS[ctx.agentStage],
      systemAppend: systemContext(spec, manifestText),
      prompt: stagePrompt(ctx.agentStage, spec, { tasks, instruction: job.instruction ?? undefined }),
      deadlineAt: ctx.startedAt + SANDBOX_TIMEOUT_MS - 8 * 60_000,
      log,
    });
    ctx.summary = outcome.summary;
    if (!outcome.ok) {
      await emit(ctx, { type: "STAGE", stage: ctx.agentStage, status: "FAIL" });
      throw new JobFailure(`agent failed: ${outcome.error ?? "unknown"}`);
    }
    await emit(ctx, { type: "STAGE", stage: ctx.agentStage, status: "DONE" });
  }

  await emit(ctx, { type: "STAGE", stage: "VERIFY", status: "START" });
  const verify = await verifyApp(sbx, log);
  if (!verify.buildOk) {
    await emit(ctx, { type: "STAGE", stage: "VERIFY", status: "FAIL" });
    throw new JobFailure(`npm run build failed:\n${verify.buildOutput.slice(-1500)}`);
  }
  await emit(ctx, {
    type: "TEST_RESULT",
    passed: verify.test.passed,
    failed: verify.test.failed,
    output: verify.test.output.slice(-4000),
  });
  if (verify.test.failed > 0) {
    await emit(ctx, { type: "STAGE", stage: "VERIFY", status: "FAIL" });
    throw new JobFailure(`${verify.test.failed} test(s) failed:\n${verify.test.output.slice(-1500)}`);
  }
  if (verify.lighthouse) await emit(ctx, { type: "LIGHTHOUSE", ...verify.lighthouse });
  else if (verify.lighthouseNote) await emit(ctx, { type: "AGENT_NOTE", text: verify.lighthouseNote });
  await emit(ctx, { type: "STAGE", stage: "VERIFY", status: "DONE" });

  const change = await stageAndDiff(sbx);
  if (ctx.agentStage) {
    const review = await reviewChange({ diff: change.diff, files: change.files, manifest: change.manifest, spec });
    ctx.reviewerCost += review.costMicros;
    await prisma.buildJob.update({ where: { id: job.id }, data: { reviewVerdict: review.verdict.verdict } });
    await emit(ctx, { type: "REVIEW", ...review.verdict });
    if (review.verdict.verdict === "REJECT") {
      if (review.verdict.findings.some((f) => f.severity === "BLOCK")) {
        await prisma.abuseFlag.create({
          data: {
            appId: app.id,
            source: "REVIEWER",
            category: "POLICY",
            reason: review.verdict.findings
              .filter((f) => f.severity === "BLOCK")
              .map((f) => f.text)
              .join("; ")
              .slice(0, 1000),
          },
        });
      }
      throw new JobFailure(`review rejected: ${review.verdict.summary}`);
    }
  }

  await emit(ctx, { type: "STAGE", stage: "DEPLOY", status: "START" });
  const repo = await ensureAppRepo(app);
  const message =
    ctx.agentStage === "MVP"
      ? `pyre: MVP build (${job.id})`
      : ctx.agentStage === "ITERATE"
        ? `pyre: iteration (${job.id})`
        : ctx.agentStage === "SELF_HEAL"
          ? `pyre: self-heal (${job.id})`
          : `pyre: deploy (${job.id})`;
  const commit = await commitAndPush(sbx, { fullName: repo.fullName, message });
  ctx.commitSha = commit.sha;
  await emit(ctx, { type: "COMMIT", sha: commit.sha, message, url: commit.url });

  let deploy;
  try {
    deploy = await createDeployment({
      sbx,
      appId: app.id,
      slug: app.slug,
      commitSha: commit.sha,
      screenshots: verify.screenshots,
    });
  } catch (e) {
    if (e instanceof BundleError) {
      await emit(ctx, { type: "STAGE", stage: "DEPLOY", status: "FAIL" });
      throw new JobFailure(`deploy rejected: ${e.message}`);
    }
    throw e;
  }
  ctx.deploymentId = deploy.deploymentId;
  for (const s of verify.screenshots) {
    await emit(ctx, { type: "SCREENSHOT", url: `${deploy.url}/_pyre/screenshots/${s.label}.png`, label: s.label });
  }
  await emit(ctx, { type: "DEPLOY", version: deploy.version, url: deploy.url });
  await emit(ctx, { type: "STAGE", stage: "DEPLOY", status: "DONE" });

  if (job.taskIds.length > 0) {
    await prisma.promptQueueItem.updateMany({ where: { id: { in: job.taskIds } }, data: { status: "DONE" } });
  }
  await queues.growth.add(
    "deploy",
    { appId: app.id, kind: "deploy", version: deploy.version },
    { jobId: `growth-deploy-${app.id}-${deploy.version}` },
  );
};

/** A fresh attempt with the orphaned job's own terms; the settled job already reopened its tasks. */
const requeueBuild = async (job: BuildJob & { app: App }, log: Logger): Promise<void> => {
  if (job.app.status !== "LIVE") return;
  const id = await enqueueBuildJob({
    app: job.app,
    stage: job.stage,
    budgetMicros: job.budgetMicros,
    taskIds: job.taskIds,
    instruction: job.instruction ?? undefined,
    prNumber: job.prNumber ?? undefined,
  });
  log.warn({ orphanedJobId: job.id, jobId: id, appId: job.appId, stage: job.stage }, "orphaned build settled and re-queued");
};

/** Execute one BuildJob end to end. Idempotent for non-QUEUED jobs. */
export const runBuildJob = async (jobId: string, log: Logger): Promise<void> => {
  const job = await prisma.buildJob.findUnique({ where: { id: jobId }, include: { app: true } });
  if (!job) {
    log.warn({ jobId }, "build job row missing");
    return;
  }
  if (job.status === "RUNNING" && !inFlightBuilds.has(job.id)) {
    // BullMQ re-delivered a stalled job: the runner that owned it died mid-build (deploy, OOM,
    // crash) before its shutdown hook could settle it. Settle now — real spend debited, sandbox
    // killed, tasks reopened — and queue a fresh attempt instead of leaving it to the 3h reaper.
    const settled = await settleAbandonedJob(job.id, "runner died mid-build; settled on stalled re-delivery and re-queued", log);
    if (settled) await requeueBuild(job, log);
    return;
  }
  if (job.status !== "QUEUED") {
    log.info({ jobId, status: job.status }, "build job not queued; skipping");
    return;
  }
  const app = job.app;
  const fail = async (error: string) => {
    await prisma.buildJob.update({ where: { id: job.id }, data: { status: "FAILED", error, finishedAt: new Date() } });
    await publishEvent(app.id, { type: "JOB_FAILED", costUsd: 0, error }, job.id);
  };
  if (app.status !== "LIVE") {
    await prisma.buildJob.update({
      where: { id: job.id },
      data: { status: "CANCELLED", error: `app is ${app.status}`, finishedAt: new Date() },
    });
    return;
  }
  const specParsed = AppSpec.safeParse(app.spec);
  if (!specParsed.success) {
    await fail("app has no valid spec");
    return;
  }
  const agentStage = AGENT_STAGE[job.stage];
  if (job.stage === "PR_REVIEW") {
    await fail("PR_REVIEW jobs run on the prReview queue");
    return;
  }

  let budgetMicros = job.budgetMicros;
  if (agentStage) {
    const daily = await dailyComputeRemaining();
    budgetMicros = [job.budgetMicros, app.budgetMicros, daily].reduce((a, b) => (a < b ? a : b));
    if (budgetMicros < BigInt(ITERATION_BUDGET_USD.MIN) * 1_000_000n) {
      await fail(`insufficient budget: $${(Number(budgetMicros) / 1e6).toFixed(2)} available`);
      return;
    }
  }

  const ctx: Ctx = {
    job,
    app,
    spec: specParsed.data,
    token: `sjt_${nanoid(40)}`,
    budgetMicros,
    agentStage,
    model: agentStage === "ITERATE" ? models.ROUTINE : models.ARCHITECT,
    startedAt: Date.now(),
    log: log.child({ jobId: job.id, appId: app.id, stage: job.stage }),
    reviewerCost: 0n,
    summary: "",
    commitSha: null,
    deploymentId: null,
  };

  await prisma.$transaction([
    prisma.buildJob.update({
      where: { id: job.id },
      data: { status: "RUNNING", startedAt: new Date(ctx.startedAt), model: ctx.model, budgetMicros },
    }),
    prisma.jobToken.create({
      data: {
        token: ctx.token,
        jobId: job.id,
        appId: app.id,
        budgetMicros: agentStage ? budgetMicros : 0n,
        expiresAt: new Date(ctx.startedAt + TOKEN_TTL_MS),
      },
    }),
  ]);

  inFlightBuilds.set(job.id, { appId: app.id, stage: job.stage, startedAt: ctx.startedAt });
  try {
    let sbx: Sandbox | null = null;
    let failure: string | null = null;
    try {
      sbx = await createSandbox(SANDBOX_TIMEOUT_MS, { appId: app.id, jobId: job.id });
      await prisma.buildJob.update({ where: { id: job.id }, data: { sandboxId: sbx.sandboxId } });
      await emit(ctx, { type: "JOB_STARTED", stage: job.stage, model: ctx.model, sandboxId: sbx.sandboxId });
      await runStages(ctx, sbx);
    } catch (e) {
      if (e instanceof JobFailure) {
        failure = e.message;
        ctx.log.warn({ error: e.message }, "build job failed");
      } else {
        failure = `internal error: ${e instanceof Error ? e.message : String(e)}`;
        ctx.log.error({ err: e }, "build job crashed");
      }
    }

    // Cleanup + accounting on every path.
    await prisma.jobToken.update({ where: { token: ctx.token }, data: { revoked: true } }).catch((e: unknown) => {
      ctx.log.error({ err: e }, "failed to revoke job token");
    });
    if (sbx) await sbx.kill().catch((e: unknown) => ctx.log.warn({ err: e }, "sandbox kill failed"));
    const tok = await prisma.jobToken.findUnique({ where: { token: ctx.token } });
    const cost = (tok?.spentMicros ?? 0n) + ctx.reviewerCost;
    const durationMs = Date.now() - ctx.startedAt;

    await prisma.buildJob.update({
      where: { id: job.id },
      data: {
        status: failure ? "FAILED" : "SUCCEEDED",
        costMicros: cost,
        error: failure,
        summary: ctx.summary.slice(0, 4000) || null,
        commitSha: ctx.commitSha,
        deploymentId: ctx.deploymentId,
        finishedAt: new Date(),
      },
    });
    await debitAppBudget(app.id, cost, "BuildJob", job.id, `${job.stage} ${app.slug}`);
    await addDailyCompute(ctx.reviewerCost);
    if (cost > 0n) {
      await audit({
        actor: "worker:build",
        action: "BUDGET_DEBIT",
        targetType: "BuildJob",
        targetId: job.id,
        meta: {
          appId: app.id,
          stage: job.stage,
          costMicros: cost,
          agentMicros: tok?.spentMicros ?? 0n,
          reviewerMicros: ctx.reviewerCost,
          outcome: failure ? "FAILED" : "SUCCEEDED",
          durationMs,
        },
      });
    }

    const costUsd = Number(cost) / 1_000_000;
    if (failure) {
      if (job.taskIds.length > 0) {
        await prisma.promptQueueItem.updateMany({
          where: { id: { in: job.taskIds }, status: "SCHEDULED" },
          data: { status: "OPEN", jobId: null },
        });
      }
      await emit(ctx, { type: "JOB_FAILED", costUsd, error: failure.slice(0, 4000) });
    } else {
      await emit(ctx, { type: "JOB_FINISHED", costUsd, durationMs, summary: ctx.summary.slice(0, 2000) });
      await checkMilestones(app.id);
      try {
        const existing = await prisma.notification.findFirst({
          where: { userId: app.launcherId, type: "BUILD_DONE", readAt: null, href: `/c/${app.slug}` },
          select: { id: true },
        });
        if (!existing) {
          await prisma.notification.create({
            data: {
              userId: app.launcherId,
              type: "BUILD_DONE",
              title: `${app.name} just shipped a build`,
              body: ctx.summary.slice(0, 140) || null,
              href: `/c/${app.slug}`,
            },
          });
        }
      } catch (e) {
        ctx.log.error({ err: e }, "failed to create BUILD_DONE notification");
      }
    }
    await publishGlobal(app.id);
  } finally {
    inFlightBuilds.delete(job.id);
  }
};
