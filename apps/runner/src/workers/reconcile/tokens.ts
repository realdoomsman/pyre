import { prisma } from "@pyre/db";
import { audit } from "../../lib/audit.js";
import type { WorkerContext } from "../../lib/queues.js";
import { emptyOutcome, type CheckOutcome } from "./report.js";

/** Leaves the owning runner time to read `spentMicros` back after it settles a job. */
const SETTLED_GRACE_MS = 60_000;

const SETTLED_STATUS: Record<string, true> = { SUCCEEDED: true, FAILED: true, CANCELLED: true };

/**
 * JOBTOKENS: a live token is a spendable credential against the Anthropic proxy.
 * Anything whose build is finished or gone is revoked and deleted; a token that
 * expired while its build is still running is revoked but kept for the reaper.
 */
export const checkJobTokens = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const log = ctx.log.child({ worker: "reconcile", check: "JOBTOKENS" });
  const now = new Date();
  const candidates = await prisma.jobToken.findMany({
    where: { OR: [{ expiresAt: { lt: now } }, { revoked: true }] },
    select: { token: true, jobId: true, appId: true, revoked: true, expiresAt: true, spentMicros: true },
  });
  outcome.checked = candidates.length;
  if (candidates.length === 0) return outcome;

  const jobs = await prisma.buildJob.findMany({
    where: { id: { in: candidates.map((c) => c.jobId) } },
    select: { id: true, status: true, finishedAt: true },
  });
  const jobById: Record<string, { status: string; finishedAt: Date | null }> = {};
  for (const job of jobs) jobById[job.id] = { status: job.status, finishedAt: job.finishedAt };

  const deletable: string[] = [];
  let orphaned = 0;
  for (const token of candidates) {
    const job = jobById[token.jobId];
    if (!job) {
      deletable.push(token.token);
      orphaned++;
      continue;
    }
    if (!SETTLED_STATUS[job.status]) {
      if (token.expiresAt >= now || token.revoked) continue;
      await prisma.jobToken.update({ where: { token: token.token }, data: { revoked: true } });
      outcome.drifted++;
      outcome.repaired++;
      outcome.findings.push({
        code: "EXPIRED_TOKEN_ON_LIVE_JOB",
        detail: `token for ${job.status} job expired at ${token.expiresAt.toISOString()}; revoked, row kept for the reaper`,
        jobId: token.jobId,
        appId: token.appId,
      });
      log.warn({ jobId: token.jobId, expiresAt: token.expiresAt }, "revoked expired token on a live job");
      continue;
    }
    if (job.finishedAt && Date.now() - job.finishedAt.getTime() < SETTLED_GRACE_MS) continue;
    deletable.push(token.token);
  }

  if (deletable.length > 0) {
    const revoked = await prisma.jobToken.updateMany({ where: { token: { in: deletable }, revoked: false }, data: { revoked: true } });
    const removed = await prisma.jobToken.deleteMany({ where: { token: { in: deletable } } });
    outcome.drifted += removed.count;
    outcome.repaired += removed.count;
    outcome.findings.push({
      code: "SPENT_TOKENS_DELETED",
      detail: `deleted ${removed.count} token(s) for settled or missing builds (${orphaned} orphaned, ${revoked.count} still live when found)`,
    });
    await audit({
      actor: "worker:reconcile",
      action: "REVOKE_TOKEN",
      targetType: "JobToken",
      targetId: `reconcile-${now.toISOString()}`,
      meta: { deleted: removed.count, orphaned, revokedOnDelete: revoked.count },
    });
    log.info({ deleted: removed.count, orphaned, revokedOnDelete: revoked.count }, "cleaned up job tokens");
  }
  return outcome;
};
