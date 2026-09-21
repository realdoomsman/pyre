import { prisma, type BuildEvent } from "@pyre/db";
import type { BuildEventPayload } from "@pyre/shared";
import { createRedis } from "./queues.js";

const publisher = createRedis();

/** Insert a BuildEvent row and publish it on `feed:<appId>`. */
export const publishEvent = async (
  appId: string,
  payload: BuildEventPayload,
  jobId?: string,
): Promise<BuildEvent> => {
  const row = await prisma.buildEvent.create({
    data: { appId, jobId: jobId ?? null, type: payload.type, payload },
  });
  await publisher.publish(
    `feed:${appId}`,
    JSON.stringify({
      id: row.id,
      appId: row.appId,
      jobId: row.jobId,
      type: row.type,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
    }),
  );
  return row;
};

/** Notify leaderboard consumers that an app's ranking inputs changed. */
export const publishGlobal = async (appId: string): Promise<void> => {
  await publisher.publish("feed:*global*", JSON.stringify({ appId }));
};

export const closePublisher = async (): Promise<void> => {
  await publisher.quit();
};
