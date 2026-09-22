import { prisma } from "@pyre/db";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { GROWTH_APP_SELECT } from "./compose.js";
import { postChangelog } from "./handlers.js";
import { DAY_MS, MIN_GROWTH_BUDGET_MICROS } from "./jobs.js";
import { replyToMentions } from "./replies.js";
import { fetchMentions, xClient, type Mention } from "./x.js";

/**
 * Daily sweep over every growth-enabled LIVE app with budget: changelog thread and
 * mention replies (one mention fetch shared across apps).
 */
export async function runDailyGrowth(redis: Redis, log: Logger): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { status: "LIVE", growthEnabled: true, budgetMicros: { gte: MIN_GROWTH_BUDGET_MICROS } },
    select: GROWTH_APP_SELECT,
    orderBy: { usersCount: "desc" },
  });
  log.info({ apps: apps.length }, "growth daily sweep start");

  const x = xClient();
  let mentions: Mention[] = [];
  if (x && apps.length) {
    try {
      mentions = await fetchMentions(x, new Date(Date.now() - DAY_MS));
    } catch (err) {
      log.error({ err }, "growth: failed to fetch mentions");
    }
  } else if (!x) {
    log.warn("growth: X_API_* not configured; posts recorded to feed only, no mention replies");
  }

  for (const app of apps) {
    const appLog = log.child({ appId: app.id, slug: app.slug });
    try {
      const changelog = await postChangelog(app, redis, appLog);
      // Each step spends; re-read so later steps see the real remaining budget.
      const fresh = await prisma.app.findUniqueOrThrow({ where: { id: app.id }, select: GROWTH_APP_SELECT });
      const replies =
        mentions.length && fresh.budgetMicros >= MIN_GROWTH_BUDGET_MICROS
          ? await replyToMentions(fresh, mentions, redis, appLog)
          : 0;
      appLog.info({ changelog, replies }, "growth daily app done");
    } catch (err) {
      appLog.error({ err }, "growth daily app failed");
    }
  }
  log.info("growth daily sweep done");
}
