import { Worker } from "bullmq";
import { queues, type WorkerContext } from "../../lib/queues.js";
import { runDailyGrowth } from "./daily.js";
import { handleGrowthJob } from "./handlers.js";
import { DAILY_JOB_NAME, DAY_MS, GrowthJobData } from "./jobs.js";

/**
 * Growth worker: per-app posts (milestone/deploy/revive/changelog/reply) on the
 * `growth` queue, plus the repeatable `growth:daily` sweep every 24h.
 */
export async function registerGrowthWorkers(ctx: WorkerContext): Promise<Worker[]> {
  const log = ctx.log.child({ worker: "growth" });

  await queues.growth.upsertJobScheduler(
    DAILY_JOB_NAME,
    { every: DAY_MS },
    { name: DAILY_JOB_NAME, data: {}, opts: { removeOnComplete: { count: 30 }, removeOnFail: { count: 30 } } },
  );

  const worker = new Worker(
    "growth",
    async (job) => {
      if (job.name === DAILY_JOB_NAME) {
        await runDailyGrowth(ctx.redis, log);
        return;
      }
      const data = GrowthJobData.parse(job.data);
      await handleGrowthJob(data, ctx.redis, log.child({ appId: data.appId, kind: data.kind, jobId: job.id }));
    },
    { connection: ctx.redis, concurrency: 2, lockDuration: 5 * 60_000 },
  );
  worker.on("failed", (job, err) => log.error({ jobId: job?.id, name: job?.name, err }, "growth job failed"));
  worker.on("error", (err) => log.error({ err }, "growth worker error"));
  log.info("growth worker registered");
  return [worker];
}
