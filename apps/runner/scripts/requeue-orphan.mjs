#!/usr/bin/env node
/**
 * Settle a BuildJob left RUNNING by a runner that died, and queue a fresh attempt with the same terms.
 * The runner does this itself when BullMQ re-delivers the stalled job; this is for the cases where
 * it cannot (the BullMQ job already completed, or the row predates that behaviour).
 *
 *   railway ssh --service runner -- node apps/runner/scripts/requeue-orphan.mjs <buildJobId>
 */
import { prisma } from "@pyre/db";
import pino from "pino";
import { settleAbandonedJob } from "../dist/workers/reconcile/jobs.js";
import { enqueueBuildJob } from "../dist/workers/scheduler.js";

const id = process.argv[2];
if (!id) throw new Error("usage: requeue-orphan.mjs <buildJobId>");
const log = pino();
const job = await prisma.buildJob.findUnique({ where: { id }, include: { app: true } });
if (!job) throw new Error(`no BuildJob ${id}`);
const settled = await settleAbandonedJob(job.id, "runner died mid-build; settled by ops and re-queued", log);
console.log(settled ? `settled ${job.id}: debited ${settled.costMicros} micros, sandboxKilled=${settled.sandboxKilled}` : `job ${job.id} is ${job.status}; nothing to settle`);
if (settled && job.app.status === "LIVE") {
  const fresh = await enqueueBuildJob({
    app: job.app,
    stage: job.stage,
    budgetMicros: job.budgetMicros,
    taskIds: job.taskIds,
    instruction: job.instruction ?? undefined,
    prNumber: job.prNumber ?? undefined,
  });
  console.log(`re-queued as ${fresh}`);
}
await prisma.$disconnect();
process.exit(0);
