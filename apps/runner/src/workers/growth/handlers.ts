import { prisma } from "@pyre/db";
import { AppSpec } from "@pyre/shared";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { appLiveUrl } from "../../env.js";
import { composeChangelog, composeDeploy, composeRevive, GROWTH_APP_SELECT, recentEvents, type GrowthApp } from "./compose.js";
import { DAY_MS, MIN_GROWTH_BUDGET_MICROS, type GrowthJobData } from "./jobs.js";
import { publishPost } from "./post.js";
import { replyToMentions } from "./replies.js";
import { fetchMentions, xClient } from "./x.js";

const INACTIVE: Record<string, true> = { KILLED: true, FAILED: true, DRAFT: true, SPEC_READY: true, AWAITING_STAKE: true, LAUNCHING: true, LAUNCH_GATED: true };

/** App row for growth work, or null (with a log line) when it must not spend on growth. */
export async function loadGrowthApp(appId: string, log: Logger): Promise<GrowthApp | null> {
  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: { ...GROWTH_APP_SELECT, status: true, growthEnabled: true },
  });
  if (!app) {
    log.warn({ appId }, "growth: app not found");
    return null;
  }
  if (INACTIVE[app.status] || !app.growthEnabled || app.budgetMicros < MIN_GROWTH_BUDGET_MICROS) {
    log.info(
      { appId, status: app.status, growthEnabled: app.growthEnabled, budgetMicros: app.budgetMicros.toString() },
      "growth: app not eligible",
    );
    return null;
  }
  return app;
}

/** Deterministic milestone card: the MVP milestone links the live app. */
export function milestoneText(app: GrowthApp, milestone: string): string {
  const spec = AppSpec.safeParse(app.spec);
  const what = spec.success ? spec.data.oneLiner : app.name;
  if (/mvp|live/i.test(milestone)) return `$${app.ticker} is live — ${what} — ${appLiveUrl(app.slug)}`;
  return `$${app.ticker} reached ${milestone.replace(/_/g, " ")} — ${what} — ${appLiveUrl(app.slug)}`;
}

/** Changelog thread for the last 24h; at most one per app per 20h (Redis guard). */
export async function postChangelog(app: GrowthApp, redis: Redis, log: Logger): Promise<boolean> {
  const claimed = await redis.set(`growth:changelog:${app.id}`, "1", "EX", 20 * 3600, "NX");
  if (!claimed) return false;
  const events = await recentEvents(app.id, new Date(Date.now() - DAY_MS));
  if (!events.length) {
    log.info({ appId: app.id }, "growth: no events in last 24h, skipping changelog");
    return false;
  }
  const { tweets, costMicros } = await composeChangelog(app, events);
  await publishPost(app, tweets, costMicros, "growth changelog thread", log);
  return true;
}

/** Fetch mentions (X only) and reply for one app. */
export async function postReplies(app: GrowthApp, redis: Redis, log: Logger): Promise<number> {
  const x = xClient();
  if (!x) {
    log.warn({ appId: app.id }, "growth: X not connected, cannot read mentions");
    return 0;
  }
  const mentions = await fetchMentions(x, new Date(Date.now() - DAY_MS));
  return replyToMentions(app, mentions, redis, log);
}

export async function handleGrowthJob(data: GrowthJobData, redis: Redis, log: Logger): Promise<void> {
  const app = await loadGrowthApp(data.appId, log);
  if (!app) return;

  if (data.text) {
    await publishPost(app, [data.text.slice(0, 280)], 0n, `growth ${data.kind} (provided text)`, log);
    return;
  }

  switch (data.kind) {
    case "milestone": {
      const milestone = data.milestone ?? "milestone";
      await publishPost(app, [milestoneText(app, milestone)], 0n, `growth milestone ${milestone}`, log);
      return;
    }
    case "deploy": {
      const version = data.version ?? app.liveVersion;
      const events = await recentEvents(app.id, new Date(Date.now() - DAY_MS));
      const { tweets, costMicros } = await composeDeploy(app, events, version);
      await publishPost(app, tweets, costMicros, `growth deploy v${version}`, log);
      return;
    }
    case "revive": {
      const { tweets, costMicros } = await composeRevive(app);
      await publishPost(app, tweets, costMicros, "growth revive", log);
      return;
    }
    case "changelog":
      await postChangelog(app, redis, log);
      return;
    case "reply":
      await postReplies(app, redis, log);
      return;
  }
}
