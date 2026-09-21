import { prisma } from "@pyre/db";
import { REVENUE_MILESTONES_USD } from "@pyre/shared";
import { publishEvent, publishGlobal } from "./publishEvent.js";
import { queues } from "./queues.js";

/**
 * Compare an app's revenue and MVP state against the milestone table, record
 * any newly reached milestone on `App.milestones`, post a MILESTONE event and
 * hand it to the growth queue. Returns the newly reached milestone names.
 */
export const checkMilestones = async (appId: string): Promise<string[]> => {
  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: {
      id: true,
      revenueMicros: true,
      mvpLiveAt: true,
      liveVersion: true,
      milestones: true,
      growthEnabled: true,
      firstRevenueAt: true,
    },
  });
  if (!app) return [];
  const reached: string[] = Array.isArray(app.milestones)
    ? app.milestones.filter((m): m is string => typeof m === "string")
    : [];
  const fresh: Array<{ name: string; value: number }> = [];

  if (app.mvpLiveAt && app.liveVersion > 0 && !reached.includes("mvp_live")) {
    fresh.push({ name: "mvp_live", value: app.liveVersion });
  }
  for (const usd of REVENUE_MILESTONES_USD) {
    const name = `revenue_${usd}`;
    if (app.revenueMicros >= BigInt(usd) * 1_000_000n && !reached.includes(name)) fresh.push({ name, value: usd });
  }
  if (fresh.length === 0) return [];

  const hitRevenue = fresh.some((f) => f.name.startsWith("revenue_"));
  await prisma.app.update({
    where: { id: appId },
    data: {
      milestones: [...reached, ...fresh.map((f) => f.name)],
      growthEnabled: app.growthEnabled || hitRevenue,
      firstRevenueAt: hitRevenue && !app.firstRevenueAt ? new Date() : undefined,
    },
  });
  for (const f of fresh) {
    await publishEvent(appId, { type: "MILESTONE", milestone: f.name, value: f.value });
    await queues.growth.add(
      "milestone",
      { appId, kind: "milestone", milestone: f.name },
      { jobId: `growth-milestone-${appId}-${f.name}` },
    );
  }
  await publishGlobal(appId);
  return fresh.map((f) => f.name);
};
