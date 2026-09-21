import { configureSendLock, redisSendLockStore } from "@pyre/chain";
import { prisma } from "@pyre/db";
import type { Worker } from "bullmq";
import { inFlightBuilds } from "./build/engine.js";
import { E2B_TEMPLATE_DEFAULT, env } from "./env.js";
import { log } from "./lib/logger.js";
import { closePublisher } from "./lib/publishEvent.js";
import { closeQueues, createRedis, type WorkerContext } from "./lib/queues.js";
import { registerBuildWorker } from "./workers/build.js";
import { registerChainWorkers } from "./workers/chain/index.js";
import { registerGrowthWorkers } from "./workers/growth/index.js";
import { registerIntakeWorker } from "./workers/intake.js";
import { registerMonitorWorker } from "./workers/monitor.js";
import { registerPrReviewWorker } from "./workers/prReview.js";
import { settleAbandonedJob, registerReconcileWorker } from "./workers/reconcile/index.js";
import { registerSchedulerWorker } from "./workers/scheduler.js";

/** Railway sends SIGTERM and waits 60s; leave room to settle builds and close clients. */
const DRAIN_TIMEOUT_MS = 25_000;
/** Absolute ceiling on shutdown: past this the process is stuck and must die. */
const SHUTDOWN_TIMEOUT_MS = 45_000;

const main = async (): Promise<void> => {
  await prisma.$connect();
  const redis = createRedis();
  // Treasury and app wallets are also signed by the API: the send lock serialises them across processes.
  configureSendLock(redisSendLockStore(redis));
  const ctx: WorkerContext = { redis, log };

  const workers: Worker[] = (
    await Promise.all([
      registerIntakeWorker(ctx),
      registerBuildWorker(ctx),
      registerSchedulerWorker(ctx),
      registerMonitorWorker(ctx),
      registerPrReviewWorker(ctx),
      registerChainWorkers(ctx),
      registerGrowthWorkers(ctx),
      registerReconcileWorker(ctx),
    ])
  ).flat();
  log.info(
    { env: env.NODE_ENV, queues: workers.map((w) => w.name), template: env.E2B_TEMPLATE ?? E2B_TEMPLATE_DEFAULT },
    "runner started",
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const startedAt = Date.now();
    const inFlightAtStart = [...inFlightBuilds.keys()];
    log.info({ signal, inFlightBuilds: inFlightAtStart.length }, "runner shutting down");
    const timer = setTimeout(() => {
      log.error({ signal }, "shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    // Worker.close() stops fetching new jobs and waits for in-flight handlers.
    const drain = Promise.allSettled(workers.map((w) => w.close()));
    const drained = await Promise.race([
      drain.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS).unref()),
    ]);

    // Anything still building is abandoned by this process: settle it now (job FAILED,
    // token revoked, sandbox killed, queue items reopened) so nothing dangles as RUNNING.
    const stranded = [...inFlightBuilds.keys()];
    const settled: string[] = [];
    for (const jobId of stranded) {
      const result = await settleAbandonedJob(
        jobId,
        `runner received ${signal} and shut down mid-build; the job was settled for rescheduling`,
        log,
      ).catch((err: unknown) => {
        log.error({ err, jobId }, "failed to settle in-flight build during shutdown");
        return null;
      });
      if (result) settled.push(result.jobId);
    }

    if (!drained) await Promise.allSettled(workers.map((w) => w.close(true)));
    await Promise.allSettled([closeQueues(), closePublisher(), redis.quit(), prisma.$disconnect()]);
    clearTimeout(timer);
    log.info(
      {
        signal,
        drained,
        drainMs: Date.now() - startedAt,
        workers: workers.length,
        buildsInFlightAtSignal: inFlightAtStart.length,
        buildsStrandedAfterDrain: stranded.length,
        buildsSettled: settled,
      },
      "runner shutdown complete",
    );
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => log.error({ err: reason }, "unhandled rejection"));
};

main().catch((e: unknown) => {
  log.fatal({ err: e }, "runner failed to start");
  process.exit(1);
});
