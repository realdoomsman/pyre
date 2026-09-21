import { prisma } from "@pyre/db";
import { LAUNCH_PHASE } from "@pyre/shared";
import type { LaunchRecord } from "@pyre/chain";
import type { ChainWorkerContext } from "./context.js";
import { publishEvent, publishGlobal } from "./publish.js";

export type LaunchStateApp = { id: string; launchPhase: number; poolId: string | null; graduatedAt: Date | null };

/**
 * Mirrors the factory's `LaunchedToken.phase` onto the app. Every chain pass calls this with the
 * launch record it just read, so whichever worker sees a graduation first records it once and
 * announces it once (`graduatedAt` is the idempotency guard).
 */
export async function syncLaunchPhase(ctx: ChainWorkerContext, app: LaunchStateApp, launch: LaunchRecord): Promise<void> {
  const graduated = launch.phase === LAUNCH_PHASE.POOL && app.graduatedAt === null;
  if (launch.phase === app.launchPhase && app.poolId === launch.poolId && !graduated) return;
  await prisma.app.update({
    where: { id: app.id },
    data: { launchPhase: launch.phase, poolId: launch.poolId, ...(graduated ? { graduatedAt: new Date(), progress: 1 } : {}) },
  });
  app.launchPhase = launch.phase;
  app.poolId = launch.poolId;
  if (!graduated) return;
  app.graduatedAt = new Date();
  await publishEvent(prisma, ctx.redis, app.id, { type: "GRADUATED", poolId: launch.poolId, txHash: null });
  await publishGlobal(ctx.redis, app.id);
  ctx.log.info({ appId: app.id, token: launch.token, poolId: launch.poolId }, "launch graduated to Uniswap v4");
}
