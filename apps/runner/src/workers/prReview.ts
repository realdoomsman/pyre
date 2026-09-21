import { transferEth, treasury } from "@pyre/chain";
import type { Address } from "viem";
import { big, prisma, type App, type PullRequest } from "@pyre/db";
import { AppSpec } from "@pyre/shared";
import { Worker } from "bullmq";
import { z } from "zod";
import { reviewChange } from "../build/reviewer.js";
import { audit } from "../lib/audit.js";
import { addDailyCompute, debitAppBudget } from "../lib/compute.js";
import { octokit, repoParts } from "../lib/github.js";
import { publishEvent, publishGlobal } from "../lib/publishEvent.js";
import type { WorkerContext } from "../lib/queues.js";
import { withLock } from "../lib/lock.js";
import { enqueueBuildJob } from "./scheduler.js";

const PrReviewJob = z.object({ appId: z.string(), prNumber: z.number().int().positive() });

/** A single PR review runs an LLM pass plus GitHub round trips; autoRenew keeps the lock alive for the duration. */
const PR_REVIEW_LOCK_TTL_SECONDS = 300;

const ensurePullRequestRow = async (
  app: Pick<App, "id" | "repoFullName">,
  prNumber: number,
): Promise<{ pr: PullRequest; body: string; headSha: string }> => {
  const { owner, repo } = repoParts(app.repoFullName!);
  const gh = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const pr = await prisma.pullRequest.upsert({
    where: { appId_number: { appId: app.id, number: prNumber } },
    create: {
      appId: app.id,
      number: prNumber,
      authorLogin: gh.data.user?.login ?? "unknown",
      title: gh.data.title.slice(0, 300),
      url: gh.data.html_url,
      status: gh.data.merged ? "MERGED" : "OPEN",
      mergeSha: gh.data.merge_commit_sha ?? null,
    },
    update: { title: gh.data.title.slice(0, 300), url: gh.data.html_url },
  });
  return { pr, body: gh.data.body ?? "", headSha: gh.data.head.sha };
};

/** Pay the bounty tied to this PR (claimed via API, or referenced as `Closes #<bountyId>` in the body). */
const payBounty = async (
  app: Pick<App, "id">,
  pr: PullRequest,
  body: string,
  log: WorkerContext["log"],
): Promise<void> => {
  const referenced = [...body.matchAll(/closes\s+#([a-z0-9]{10,})/gi)].map((m) => m[1]!);
  const bounty = await prisma.bounty.findFirst({
    where: {
      appId: app.id,
      status: "CLAIMED",
      OR: [{ prNumber: pr.number }, ...(referenced.length > 0 ? [{ id: { in: referenced } }] : [])],
    },
  });
  if (!bounty) return;
  const to = bounty.claimantWallet ?? pr.authorWallet;
  if (!to) {
    log.warn({ bountyId: bounty.id }, "bounty claimed but no payout wallet; leaving CLAIMED");
    return;
  }
  // CAS the bounty CLAIMED -> PAID before spending: only the winner (count === 1) performs the transfer,
  // so a retry or a concurrent reviewer can never double-pay the bounty. There is no intermediate
  // status in BountyStatus, so PAID is set first (payoutTx filled in after the transfer confirms).
  const claim = await prisma.bounty.updateMany({
    where: { id: bounty.id, status: "CLAIMED" },
    data: { status: "PAID", prNumber: pr.number, claimantWallet: to },
  });
  if (claim.count !== 1) {
    log.info({ bountyId: bounty.id }, "bounty already paid or no longer claimable; skipping payout");
    return;
  }
  const wei = big(bounty.wei);
  const hash = await transferEth(treasury().account, to as Address, wei);
  await prisma.$transaction([
    prisma.bounty.update({
      where: { id: bounty.id },
      data: { payoutTx: hash },
    }),
    prisma.ledgerEntry.create({
      data: {
        account: "TREASURY",
        deltaMicros: 0n,
        refType: "Payout",
        refId: bounty.id,
        memo: `bounty payout ${wei.toString()} wei to ${to} (${hash})`,
      },
    }),
  ]);
  await audit({
    actor: "worker:prReview",
    action: "BOUNTY_PAYOUT",
    targetType: "Bounty",
    targetId: bounty.id,
    meta: { appId: app.id, wei, to, hash, prNumber: pr.number },
  });
  await publishEvent(app.id, {
    type: "BOUNTY_CLAIMED",
    bountyId: bounty.id,
    amountWei: wei.toString(),
    claimant: to as Address,
  });
};

const runReview = async (ctx: WorkerContext, appId: string, prNumber: number): Promise<void> => {
  const log = ctx.log.child({ appId, prNumber, queue: "prReview" });
  const app = await prisma.app.findUnique({ where: { id: appId } });
  if (!app || !app.repoFullName) {
    log.warn("prReview: app missing or has no repo");
    return;
  }
  const spec = AppSpec.safeParse(app.spec);
  if (!spec.success) {
    log.warn("prReview: app has no valid spec");
    return;
  }
  const { pr, body, headSha } = await ensurePullRequestRow(app, prNumber);
  if (pr.status === "MERGED" || pr.status === "REJECTED") {
    log.info({ status: pr.status }, "prReview: already decided");
    return;
  }
  const { owner, repo } = repoParts(app.repoFullName);
  const job = await prisma.buildJob.create({
    data: { appId: app.id, stage: "PR_REVIEW", status: "RUNNING", budgetMicros: 0n, prNumber, startedAt: new Date() },
  });
  await prisma.pullRequest.update({ where: { id: pr.id }, data: { status: "REVIEWING" } });
  await publishEvent(app.id, { type: "JOB_STARTED", stage: "PR_REVIEW", model: "reviewer", sandboxId: "" }, job.id);

  try {
    const diffRes = await octokit.pulls.get({ owner, repo, pull_number: prNumber, mediaType: { format: "diff" } });
    // Octokit types the diff response as the PR object; with `format: "diff"` the body is the raw unified diff.
    const diff = String(diffRes.data);
    const files = await octokit.paginate(octokit.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 });
    let manifest = "";
    try {
      const content = await octokit.repos.getContent({ owner, repo, path: "pyre.manifest.json", ref: headSha });
      if (!Array.isArray(content.data) && content.data.type === "file" && content.data.content) {
        manifest = Buffer.from(content.data.content, "base64").toString("utf8");
      }
    } catch {
      manifest = "";
    }

    const review = await reviewChange({
      diff,
      files: files.map((f) => f.filename),
      manifest,
      spec: spec.data,
    });
    await addDailyCompute(review.costMicros);
    await debitAppBudget(app.id, review.costMicros, "BuildJob", job.id, `PR #${prNumber} review`);
    if (review.costMicros > 0n) {
      await audit({
        actor: "worker:prReview",
        action: "BUDGET_DEBIT",
        targetType: "BuildJob",
        targetId: job.id,
        meta: { appId: app.id, stage: "PR_REVIEW", costMicros: review.costMicros, prNumber },
      });
    }
    await publishEvent(app.id, { type: "REVIEW", ...review.verdict }, job.id);

    if (review.verdict.verdict === "REJECT") {
      const findings = review.verdict.findings.map((f) => `- **${f.severity}**: ${f.text}`).join("\n");
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `Pyre reviewer rejected this change.\n\n${review.verdict.summary}\n\n${findings}\n\nAddress the findings and push again to trigger a new review.`,
      });
      await prisma.pullRequest.update({
        where: { id: pr.id },
        data: { status: "REJECTED", reviewSummary: review.verdict.summary },
      });
      await prisma.buildJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          reviewVerdict: "REJECT",
          costMicros: review.costMicros,
          error: review.verdict.summary,
          finishedAt: new Date(),
        },
      });
      await publishEvent(
        app.id,
        { type: "JOB_FAILED", costUsd: Number(review.costMicros) / 1e6, error: `PR #${prNumber} rejected: ${review.verdict.summary}` },
        job.id,
      );
      return;
    }

    const merged = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: "squash",
      commit_title: `${pr.title} (#${prNumber})`,
    });
    const mergeSha = merged.data.sha;
    await prisma.pullRequest.update({
      where: { id: pr.id },
      data: { status: "MERGED", mergeSha, reviewSummary: review.verdict.summary },
    });
    if (pr.authorWallet) {
      const user = await prisma.user.findUnique({ where: { wallet: pr.authorWallet }, select: { id: true } });
      if (user) {
        await prisma.contributor.upsert({
          where: { appId_userId: { appId: app.id, userId: user.id } },
          create: { appId: app.id, userId: user.id, mergedPrs: 1 },
          update: { mergedPrs: { increment: 1 } },
        });
        await prisma.user.update({ where: { id: user.id }, data: { reputation: { increment: 1 } } });
      }
    }
    await publishEvent(app.id, { type: "PR_MERGED", prNumber, author: pr.authorLogin, url: pr.url }, job.id);
    await payBounty(app, pr, body, log).catch((e: unknown) => log.error({ err: e }, "bounty payout failed"));

    await prisma.buildJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        reviewVerdict: "APPROVE",
        costMicros: review.costMicros,
        commitSha: mergeSha,
        summary: review.verdict.summary,
        finishedAt: new Date(),
      },
    });
    await publishEvent(
      app.id,
      {
        type: "JOB_FINISHED",
        costUsd: Number(review.costMicros) / 1e6,
        durationMs: Date.now() - job.createdAt.getTime(),
        summary: `PR #${prNumber} merged: ${review.verdict.summary}`,
      },
      job.id,
    );
    await enqueueBuildJob({ app, stage: "DEPLOY", budgetMicros: 0n, prNumber, priority: 1 });
    await publishGlobal(app.id);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.error({ err: e }, "prReview failed");
    await prisma.pullRequest.update({ where: { id: pr.id }, data: { status: "OPEN" } });
    await prisma.buildJob.update({
      where: { id: job.id },
      data: { status: "FAILED", error, finishedAt: new Date() },
    });
    await publishEvent(app.id, { type: "JOB_FAILED", costUsd: 0, error: `PR #${prNumber} review error: ${error}` }, job.id);
    throw e;
  }
};

export const reviewPullRequest = async (ctx: WorkerContext, appId: string, prNumber: number): Promise<void> => {
  const outcome = await withLock(
    ctx.redis,
    `lock:prReview:${appId}:${prNumber}`,
    PR_REVIEW_LOCK_TTL_SECONDS,
    () => runReview(ctx, appId, prNumber),
    { autoRenew: true },
  );
  if (!outcome.acquired) ctx.log.info({ appId, prNumber }, "prReview skipped; PR lock held by another worker");
};

export const registerPrReviewWorker = (ctx: WorkerContext): Worker[] => {
  const worker = new Worker(
    "prReview",
    async (job) => {
      const { appId, prNumber } = PrReviewJob.parse(job.data);
      await reviewPullRequest(ctx, appId, prNumber);
    },
    { connection: ctx.redis, concurrency: 2 },
  );
  worker.on("failed", (job, err) => ctx.log.error({ jobId: job?.id, err }, "prReview job failed"));
  return [worker];
};
