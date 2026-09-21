import type { BuildEvent, PrismaClient } from "@pyre/db";
import type { BuildEventPayload } from "@pyre/shared";
import type { Redis } from "ioredis";

/** Inserts a BuildEvent row and publishes it on `feed:<appId>`. */
export async function publishEvent(
  prisma: PrismaClient,
  redis: Redis,
  appId: string,
  payload: BuildEventPayload,
  jobId?: string,
): Promise<BuildEvent> {
  const row = await prisma.buildEvent.create({ data: { appId, jobId: jobId ?? null, type: payload.type, payload } });
  await redis.publish(
    `feed:${appId}`,
    JSON.stringify({ id: row.id, appId, jobId: row.jobId, type: row.type, payload, createdAt: row.createdAt.toISOString() }),
  );
  return row;
}

/** Signals a leaderboard-affecting change for `appId`. */
export async function publishGlobal(redis: Redis, appId: string): Promise<void> {
  await redis.publish("feed:*global*", JSON.stringify({ appId }));
}
