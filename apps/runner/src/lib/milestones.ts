import { prisma } from "@pyre/db";
import { publishEvent, publishGlobal } from "./publishEvent.js";
import { queues } from "./queues.js";

/**
 * Compare an app's MVP state against the milestone table, record any newly reached milestone on
 * `App.milestones`, post a MILESTONE event and hand it to the growth queue. A live MVP also
 * switches growth posting on. Returns the newly reached milestone names.
 */
export const checkMilestones = async (appId: string): Promise<string[]> => {
  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: {
      id: true,
      mvpLiveAt: true,
      liveVersion: true,
      milestones: true,
      growthEnabled: true,
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
  if (fresh.length === 0) return [];

  await prisma.app.update({
    where: { id: appId },
    data: {
      milestones: [...reached, ...fresh.map((f) => f.name)],
      growthEnabled: true,
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
