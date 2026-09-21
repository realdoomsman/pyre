import { Worker } from "bullmq";
import { withLock } from "../../lib/lock.js";
import { queues, type WorkerContext } from "../../lib/queues.js";
import { checkBurns } from "./burns.js";
import { checkFees } from "./fees.js";
import { checkJobs } from "./jobs.js";
import { checkLedger } from "./ledger.js";
import { runCheck, type Check, type ReconcileKind } from "./report.js";
import { checkSandboxes } from "./sandboxes.js";
import { checkJobTokens } from "./tokens.js";

export { settleAbandonedJob, type SettledJob } from "./jobs.js";

const EVERY_MS = 5 * 60_000;
/** A whole pass does a handful of DB aggregates plus E2B and RPC round trips. */
const PASS_LOCK_TTL_SECONDS = 600;

/**
 * Order matters: JOBS settles dead builds first so SANDBOXES sees their sandboxes
 * as orphaned in the same pass, and JOBTOKENS then finds their tokens spent.
 */
const CHECKS: [ReconcileKind, Check][] = [
  ["JOBS", checkJobs],
  ["SANDBOXES", checkSandboxes],
  ["JOBTOKENS", checkJobTokens],
  ["LEDGER", checkLedger],
  ["FEES", checkFees],
  ["BURNS", checkBurns],
];

/** Runs every check once, writing one `ReconcileRun` row each. Safe to invoke ad hoc. */
export const runReconcilePass = async (ctx: WorkerContext): Promise<void> => {
  const log = ctx.log.child({ worker: "reconcile" });
  const pass = await withLock(ctx.redis, "lock:reconcile:pass", PASS_LOCK_TTL_SECONDS, async () => {
    const startedAt = Date.now();
    let drifted = 0;
    let repaired = 0;
    for (const [kind, check] of CHECKS) {
      const outcome = await runCheck(kind, ctx, check);
      drifted += outcome.drifted;
      repaired += outcome.repaired;
    }
    log.info({ checks: CHECKS.length, drifted, repaired, durationMs: Date.now() - startedAt }, "reconcile pass done");
  });
  if (!pass.acquired) log.info("reconcile pass skipped; lock held by another runner");
};

export const registerReconcileWorker = async (ctx: WorkerContext): Promise<Worker[]> => {
  const worker = new Worker("reconcile", () => runReconcilePass(ctx), { connection: ctx.redis, concurrency: 1 });
  worker.on("failed", (job, err) => ctx.log.error({ jobId: job?.id, err }, "reconcile job failed"));
  worker.on("error", (err) => ctx.log.error({ err }, "reconcile worker error"));
  await queues.reconcile.upsertJobScheduler("reconcileTick", { every: EVERY_MS }, { name: "tick", data: {} });
  return [worker];
};
