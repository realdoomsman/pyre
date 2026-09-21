import { Queue, type Worker } from "bullmq";
import { createBuybackWorker } from "./buyback.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { chainWorkerEnv } from "./env.js";
import { createFeeSweepWorker } from "./feeSweep.js";
import { createHoldersWorker } from "./holders.js";
import { RETRY_GATED_JOB, createLaunchWorker } from "./launch.js";
import { createMarketWorker } from "./market.js";
import { createPriceWorker } from "./price.js";

export type { ChainWorkerContext } from "./context.js";
export { publishEvent, publishGlobal } from "./publish.js";

/** Repeatable schedules owned by this module: scheduler id → queue, job name, interval. */
const SCHEDULES: Record<string, { queue: (typeof CHAIN_QUEUES)[keyof typeof CHAIN_QUEUES]; name: string; everyMs: number }> = {
  feeSweep: { queue: CHAIN_QUEUES.feeSweep, name: "sweep", everyMs: 300_000 },
  buybackScan: { queue: CHAIN_QUEUES.buyback, name: "scan", everyMs: 600_000 },
  priceRefresh: { queue: CHAIN_QUEUES.price, name: "refresh", everyMs: 60_000 },
  holdersRefresh: { queue: CHAIN_QUEUES.holders, name: "refresh", everyMs: 600_000 },
  marketRefresh: { queue: CHAIN_QUEUES.market, name: "refresh", everyMs: 60_000 },
  launchRetryGated: { queue: CHAIN_QUEUES.launch, name: RETRY_GATED_JOB, everyMs: 600_000 },
};

/**
 * Starts the on-chain workers (launch, feeSweep, buyback, price, holders, market) and registers
 * their repeatable schedules. Returns the Worker instances so the caller can close them on shutdown.
 */
export async function registerChainWorkers(ctx: ChainWorkerContext): Promise<Worker[]> {
  chainWorkerEnv();
  // BullMQ blocking workers require maxRetriesPerRequest: null; duplicate when the shared client differs.
  const connection = ctx.redis.options.maxRetriesPerRequest === null ? ctx.redis : ctx.redis.duplicate({ maxRetriesPerRequest: null });
  for (const [schedulerId, s] of Object.entries(SCHEDULES)) {
    const queue = new Queue(s.queue, { connection: ctx.redis });
    await queue.upsertJobScheduler(schedulerId, { every: s.everyMs }, { name: s.name, data: {} });
    await queue.close();
  }
  const workers = [
    createLaunchWorker(ctx, connection),
    createFeeSweepWorker(ctx, connection),
    createBuybackWorker(ctx, connection),
    createPriceWorker(ctx, connection),
    createHoldersWorker(ctx, connection),
    createMarketWorker(ctx, connection),
  ];
  for (const worker of workers) {
    worker.on("failed", (job, err) => ctx.log.error({ err, queue: worker.name, jobId: job?.id }, "chain job failed"));
    worker.on("error", (err) => ctx.log.error({ err, queue: worker.name }, "chain worker error"));
  }
  ctx.log.info({ queues: workers.map((w) => w.name) }, "chain workers registered");
  return workers;
}
