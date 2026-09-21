import { prisma, type BuildEvent } from "@pyre/db";
import type { BuildEventPayload } from "@pyre/shared";
import { redis } from "./redis.js";

export const GLOBAL_FEED_CHANNEL = "feed:*global*";

/**
 * Message on `feed:*global*`. Every api instance drops its caches for `appId` on receipt; the
 * `/v1/apps/stream` SSE relays it (enriched with the app's identity) to the live tape. `event`
 * is present when a BuildEvent row was written; bare `UPDATE`s mean "ranking inputs changed".
 */
export interface GlobalFeedMessage {
  appId: string;
  type: string;
  event?: BuildEvent;
}

/** Insert a BuildEvent row, then fan it out on `feed:<appId>` and the global channel. */
export const publishEvent = async (appId: string, payload: BuildEventPayload, jobId?: string): Promise<BuildEvent> => {
  const event = await prisma.buildEvent.create({
    data: { appId, jobId: jobId ?? null, type: payload.type, payload },
  });
  const message: GlobalFeedMessage = { appId, type: payload.type, event };
  await Promise.all([redis.publish(`feed:${appId}`, JSON.stringify(event)), redis.publish(GLOBAL_FEED_CHANNEL, JSON.stringify(message))]);
  return event;
};

/** Leaderboard-affecting change notification without a feed row. */
export const publishGlobal = async (appId: string, type = "UPDATE"): Promise<void> => {
  const message: GlobalFeedMessage = { appId, type };
  await redis.publish(GLOBAL_FEED_CHANNEL, JSON.stringify(message));
};
