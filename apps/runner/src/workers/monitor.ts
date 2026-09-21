import { prisma } from "@pyre/db";
import { HEALTHCHECK_FAILS_BEFORE_SELF_HEAL, HEALTHCHECK_INTERVAL_MS, ITERATION_BUDGET_USD } from "@pyre/shared";
import { Worker } from "bullmq";
import { appLiveUrl } from "../env.js";
import { publishEvent } from "../lib/publishEvent.js";
import { queues, type WorkerContext } from "../lib/queues.js";
import { buildsPaused } from "../lib/settings.js";
import { withLock } from "../lib/lock.js";
import { enqueueBuildJob } from "./scheduler.js";

const TIMEOUT_MS = 8_000;
/** Rolling window the EMA approximates (one day of 1-minute samples). */
const WINDOW = 1440;
const SELF_HEAL_COOLDOWN_MS = 60 * 60_000;
const MIN_ITER = BigInt(ITERATION_BUDGET_USD.MIN) * 1_000_000n;
const BATCH = 10;
/** Probes run 10 apps at a time with an 8s timeout each; the schedule is 60s. */
const TICK_LOCK_TTL_SECONDS = 120;

const probe = async (url: string): Promise<{ ok: boolean; error: string | null }> => {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "pyre-monitor/1.0", accept: "text/html" },
    });
    if (res.status === 200) {
      const body = await res.text();
      return body.length > 0 ? { ok: true, error: null } : { ok: false, error: `GET ${url} returned an empty 200 body` };
    }
    const snippet = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    return { ok: false, error: `GET ${url} → HTTP ${res.status}${snippet ? `: ${snippet}` : ""}` };
  } catch (e) {
    return { ok: false, error: `GET ${url} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
};

/** One healthcheck pass, lock-guarded so two runners cannot double-probe and double-self-heal. */
export const monitorTick = async (ctx: WorkerContext): Promise<void> => {
  const pass = await withLock(ctx.redis, "lock:monitor:tick", TICK_LOCK_TTL_SECONDS, () => monitorPass(ctx));
  if (!pass.acquired) ctx.log.info("monitor tick skipped; lock held by another runner");
};

const monitorPass = async (ctx: WorkerContext): Promise<void> => {
  const apps = await prisma.app.findMany({
    where: { status: "LIVE", liveVersion: { gt: 0 } },
    select: {
      id: true,
      slug: true,
      budgetMicros: true,
      uptimeBps: true,
      consecutiveFails: true,
      healthy: true,
    },
  });
  const paused = await buildsPaused();
  for (let i = 0; i < apps.length; i += BATCH) {
    await Promise.allSettled(
      apps.slice(i, i + BATCH).map(async (app) => {
        const url = appLiveUrl(app.slug);
        const r = await probe(url);
        const sample = r.ok ? 10_000 : 0;
        const uptimeBps = Math.round(app.uptimeBps + (sample - app.uptimeBps) / WINDOW);
        const consecutiveFails = r.ok ? 0 : app.consecutiveFails + 1;
        await prisma.app.update({
          where: { id: app.id },
          data: { healthy: r.ok, consecutiveFails, lastHealthAt: new Date(), uptimeBps },
        });
        if (r.ok) return;
        ctx.log.warn({ appId: app.id, consecutiveFails, error: r.error }, "healthcheck failed");
        if (consecutiveFails < HEALTHCHECK_FAILS_BEFORE_SELF_HEAL || paused || app.budgetMicros < MIN_ITER) return;

        const active = await prisma.buildJob.findFirst({
          where: { appId: app.id, status: { in: ["QUEUED", "RUNNING"] } },
          select: { id: true },
        });
        if (active) return;
        const recentHeal = await prisma.buildJob.findFirst({
          where: { appId: app.id, stage: "SELF_HEAL", createdAt: { gt: new Date(Date.now() - SELF_HEAL_COOLDOWN_MS) } },
          select: { id: true },
        });
        if (recentHeal) return;

        const error = r.error ?? "healthcheck failed";
        await publishEvent(app.id, { type: "SELF_HEAL", error });
        await enqueueBuildJob({
          app,
          stage: "SELF_HEAL",
          budgetMicros: app.budgetMicros < BigInt(ITERATION_BUDGET_USD.DEFAULT) * 1_000_000n ? app.budgetMicros : BigInt(ITERATION_BUDGET_USD.DEFAULT) * 1_000_000n,
          instruction: `${error}\n\nThe healthcheck fetches ${url} and expects HTTP 200 with a non-empty HTML body within ${TIMEOUT_MS / 1000}s. Consecutive failures: ${consecutiveFails}.`,
          priority: 1,
        });
      }),
    );
  }
};

export const registerMonitorWorker = async (ctx: WorkerContext): Promise<Worker[]> => {
  const worker = new Worker("monitor", async () => monitorTick(ctx), { connection: ctx.redis, concurrency: 1 });
  worker.on("failed", (job, err) => ctx.log.error({ jobId: job?.id, err }, "monitor job failed"));
  await queues.monitor.upsertJobScheduler(
    "monitor:tick",
    { every: HEALTHCHECK_INTERVAL_MS },
    { name: "tick", data: {} },
  );
  return [worker];
};
