import { BuildJobData } from "@pyre/shared";
import { DelayedError, Worker } from "bullmq";
import { runBuildJob } from "../build/engine.js";
import { dailyComputeRemaining } from "../lib/compute.js";
import { acquireLock } from "../lib/lock.js";
import type { WorkerContext } from "../lib/queues.js";
import { buildsPaused } from "../lib/settings.js";

const DEFER_MS = 15 * 60_000;
/** A build holds the app lock for up to ~50 minutes, so the lock is renewed rather than long-lived. */
const BUILD_LOCK_TTL_SECONDS = 180;
/** Another build for the same app is running (here or on a second runner): come back shortly. */
const LOCK_RETRY_MS = 60_000;

export const registerBuildWorker = ({ redis, log }: WorkerContext): Worker[] => {
  const worker = new Worker(
    "build",
    async (job, token) => {
      const data = BuildJobData.parse(job.data);
      const needsCompute = data.stage !== "DEPLOY" && data.stage !== "VERIFY";
      if ((await buildsPaused()) || (needsCompute && (await dailyComputeRemaining()) === 0n)) {
        log.info({ jobId: data.jobId }, "build deferred (paused or daily compute ceiling reached)");
        await job.moveToDelayed(Date.now() + DEFER_MS, token);
        throw new DelayedError();
      }
      // One build per app across every runner instance. The job is delayed, never
      // dropped, so a contended app still gets built.
      const lock = await acquireLock(redis, `lock:build:app:${data.appId}`, BUILD_LOCK_TTL_SECONDS, { autoRenew: true });
      if (!lock) {
        log.info({ jobId: data.jobId, appId: data.appId }, "build deferred; app build lock held");
        await job.moveToDelayed(Date.now() + LOCK_RETRY_MS, token);
        throw new DelayedError();
      }
      try {
        await runBuildJob(data.jobId, log);
      } finally {
        await lock.release();
      }
    },
    {
      connection: redis,
      concurrency: 4,
      lockDuration: 120_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    },
  );
  worker.on("failed", (job, err) => {
    if (err instanceof DelayedError) return;
    log.error({ jobId: job?.id, err }, "build job failed");
  });
  return [worker];
};
