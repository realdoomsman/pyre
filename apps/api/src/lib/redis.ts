import { configureSendLock, redisSendLockStore } from "@pyre/chain";
import { Redis } from "ioredis";
import { env } from "../env.js";
import { logger } from "./logger.js";

/** Shared command connection (BullMQ requires maxRetriesPerRequest null). */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
redis.on("error", (err) => logger.error({ err }, "redis error"));
// The treasury and app wallets are also signed by the runner: every send takes `lock:send:<address>` here.
configureSendLock(redisSendLockStore(redis));

/** Dedicated subscriber; one channel subscription per app, fanned out to SSE clients. */
const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
subscriber.on("error", (err) => logger.error({ err }, "redis subscriber error"));

type Listener = (message: string) => void;
const listeners: Record<string, Listener[]> = {};

subscriber.on("message", (channel: string, message: string) => {
  const ls = listeners[channel];
  if (!ls) return;
  for (const l of ls) l(message);
});

export const subscribeChannel = (channel: string, listener: Listener): (() => void) => {
  const existing = listeners[channel];
  if (existing) existing.push(listener);
  else {
    listeners[channel] = [listener];
    subscriber.subscribe(channel).catch((err) => logger.error({ err, channel }, "subscribe failed"));
  }
  return () => {
    const ls = listeners[channel];
    if (!ls) return;
    const i = ls.indexOf(listener);
    if (i >= 0) ls.splice(i, 1);
    if (ls.length === 0) {
      delete listeners[channel];
      subscriber.unsubscribe(channel).catch((err) => logger.error({ err, channel }, "unsubscribe failed"));
    }
  };
};

export const closeRedis = async (): Promise<void> => {
  await Promise.all([redis.quit(), subscriber.quit()]);
};
