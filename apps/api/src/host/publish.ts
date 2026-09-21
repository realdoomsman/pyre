import { prisma } from "@pyre/db";
import type { BuildEventPayload } from "@pyre/shared";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

/** Inserts a BuildEvent row and publishes it on `feed:<appId>`. */
export async function publishEvent(appId: string, payload: BuildEventPayload, jobId?: string): Promise<void> {
  try {
    const row = await prisma.buildEvent.create({
      data: { appId, jobId: jobId ?? null, type: payload.type, payload },
    });
    await redis.publish(
      `feed:${appId}`,
      JSON.stringify({ id: row.id, appId, jobId: row.jobId, type: row.type, payload, createdAt: row.createdAt }),
    );
  } catch (err) {
    logger.warn({ err, appId, type: payload.type }, "host: publishEvent failed");
  }
}

/** Signals leaderboard-affecting changes. */
export async function publishGlobal(appId: string): Promise<void> {
  try {
    await redis.publish("feed:*global*", JSON.stringify({ appId }));
  } catch (err) {
    logger.warn({ err, appId }, "host: publishGlobal failed");
  }
}
