import { prisma } from "@pyre/db";
import { Sandbox } from "e2b";
import { env } from "../../env.js";
import { audit } from "../../lib/audit.js";
import type { WorkerContext } from "../../lib/queues.js";
import { emptyOutcome, type CheckOutcome } from "./report.js";

/** A sandbox younger than this may still be racing its own `BuildJob.sandboxId` write. */
const STARTUP_GRACE_MS = 120_000;

const SETTLED_STATUS: Record<string, true> = { SUCCEEDED: true, FAILED: true, CANCELLED: true };

/**
 * The fields this check reads from a listed sandbox. `apps/runner` resolves e2b
 * **1.13.2** (its own node_modules; the repo root has 2.x), where
 * `Sandbox.list()` returns every running sandbox in one array and does not export
 * the element type. On an upgrade to e2b 2.x this is the only site to change:
 * `Sandbox.list()` becomes a `SandboxPaginator` (`hasNext` / `await nextItems()`,
 * `query.state`), and `SandboxInfo` is exported and can replace this interface.
 */
interface LiveSandbox {
  sandboxId: string;
  templateId: string;
  metadata?: Record<string, string>;
  startedAt: Date;
}

/**
 * SANDBOXES: every live E2B sandbox is billed until its own timeout, so a sandbox
 * whose build has already settled (or whose BuildJob no longer exists) is money
 * burning with nobody watching. Kills those; reports anything it cannot attribute.
 */
export const checkSandboxes = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const log = ctx.log.child({ worker: "reconcile", check: "SANDBOXES" });
  const running: LiveSandbox[] = await Sandbox.list({ apiKey: env.E2B_API_KEY });
  outcome.checked = running.length;

  for (const sbx of running) {
    const jobId = sbx.metadata?.jobId;
    const ageMs = Date.now() - sbx.startedAt.getTime();
    if (!jobId) {
      outcome.drifted++;
      outcome.findings.push({
        code: "SANDBOX_WITHOUT_JOB_METADATA",
        detail: `sandbox ${sbx.sandboxId} has no jobId metadata (template ${sbx.templateId}, up ${Math.round(ageMs / 60_000)}m); left alone`,
        sandboxId: sbx.sandboxId,
      });
      continue;
    }
    if (ageMs < STARTUP_GRACE_MS) continue;
    const job = await prisma.buildJob.findUnique({ where: { id: jobId }, select: { status: true, appId: true } });
    if (job && !SETTLED_STATUS[job.status]) continue;

    outcome.drifted++;
    const killed = await Sandbox.kill(sbx.sandboxId, { apiKey: env.E2B_API_KEY }).catch((err: unknown) => {
      log.error({ err, sandboxId: sbx.sandboxId, jobId }, "sandbox kill failed");
      outcome.ok = false;
      return null;
    });
    if (killed === null) {
      outcome.findings.push({
        code: "SANDBOX_KILL_FAILED",
        detail: `could not kill sandbox ${sbx.sandboxId} for ${job ? `${job.status} job` : "missing job"}`,
        sandboxId: sbx.sandboxId,
        jobId,
      });
      continue;
    }
    outcome.repaired++;
    outcome.findings.push({
      code: "SANDBOX_KILLED",
      detail: job
        ? `killed leaked sandbox for ${job.status} job (up ${Math.round(ageMs / 60_000)}m)`
        : `killed leaked sandbox for missing BuildJob (up ${Math.round(ageMs / 60_000)}m)`,
      sandboxId: sbx.sandboxId,
      jobId,
      appId: job?.appId,
    });
    await audit({
      actor: "worker:reconcile",
      action: "KILL_SANDBOX",
      targetType: "BuildJob",
      targetId: jobId,
      meta: { sandboxId: sbx.sandboxId, jobStatus: job?.status ?? "MISSING", appId: job?.appId ?? null, ageMs, found: killed },
    });
    log.warn({ sandboxId: sbx.sandboxId, jobId, jobStatus: job?.status ?? "MISSING" }, "killed leaked sandbox");
  }
  return outcome;
};
