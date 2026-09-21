import { Redis } from "ioredis";
import { z } from "zod";
import { env } from "../env.js";
import { GLOBAL_FEED_CHANNEL } from "./events.js";
import { stableStringify } from "./http.js";
import { logger } from "./logger.js";
import { cacheEvents, cacheLocalEntries } from "./metrics.js";
import { subscribeChannel } from "./redis.js";

/**
 * Two-tier read cache: a bounded in-process LRU in front of a Redis layer shared by every
 * api instance, with single-flight de-duplication so one cache miss under load issues one
 * database query instead of one per request.
 *
 * Cached values cross Redis as JSON, so loaders must return JSON-safe data (the route DTOs
 * already are: numbers, strings, ISO timestamps). BigInt/Date must be converted by the DTO.
 */

const LOCAL_MAX_ENTRIES = 512;
const KEY_PREFIX = "cache:v1:";
const TAG_PREFIX = "cachetag:v1:";
/** Tag sets outlive their longest member so invalidation still finds keys written last. */
const TAG_TTL_SECONDS = 900;

type Entry = { expiresAt: number; value: unknown; tags: string[] };

/** A cache read that has not answered in this long is worse than useless: fall through to Postgres. */
const REDIS_DEADLINE_MS = 150;

/**
 * The cache gets its own connection because the shared client is configured for BullMQ
 * (`maxRetriesPerRequest: null`), under which a command issued while Redis is unreachable is
 * queued forever and never rejects — a cached read would then park instead of degrading to a
 * database read. Here `maxRetriesPerRequest: 1` makes ioredis flush the offline queue with an
 * error once a reconnect fails, so the queue stays bounded during an outage, while keeping the
 * queue enabled means commands issued in the moments before the socket is up are still sent
 * rather than thrown away. Every command is additionally bounded by `withDeadline`.
 */
const cacheRedis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  connectTimeout: 2_000,
});
cacheRedis.on("error", (err) => logger.debug({ err }, "cache redis error"));

/**
 * Bounds every cache command. Without this a down or stalled Redis (failover, saturated link,
 * queued-while-offline command) would hold the request open; a cache miss must cost at most
 * this much before the route falls through to Postgres.
 */
const withDeadline = async <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("redis deadline exceeded")), REDIS_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Insertion-ordered for LRU eviction; re-inserted on hit. */
const local = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
/** tag -> keys held locally under that tag. */
const localTags = new Map<string, Set<string>>();

/** Leaderboard/platform aggregates: invalidated whenever any app's ranking inputs change. */
export const APPS_TAG = "apps";

/** Per-app tag; `feed:*global*` carries the appId, so this is the invalidation unit. */
export const appTag = (appId: string): string => `app:${appId}`;

/** Cache key from a route template plus its normalized parameters. */
export const cacheKey = (route: string, params: Record<string, string | number | boolean | null | undefined>): string =>
  `${route}|${stableStringify(params)}`;

const dropLocal = (key: string): void => {
  const entry = local.get(key);
  if (!entry) return;
  local.delete(key);
  for (const tag of entry.tags) {
    const keys = localTags.get(tag);
    if (!keys) continue;
    keys.delete(key);
    if (keys.size === 0) localTags.delete(tag);
  }
};

const setLocal = (key: string, value: unknown, expiresAt: number, tags: string[]): void => {
  dropLocal(key);
  local.set(key, { expiresAt, value, tags });
  for (const tag of tags) {
    const keys = localTags.get(tag);
    if (keys) keys.add(key);
    else localTags.set(tag, new Set([key]));
  }
  while (local.size > LOCAL_MAX_ENTRIES) {
    const oldest = local.keys().next();
    if (oldest.done === true) break;
    dropLocal(oldest.value);
  }
  cacheLocalEntries.set({}, local.size);
};

const Envelope = z.object({ e: z.number(), v: z.unknown() });

export type CacheTags<T> = string[] | ((value: T) => string[]);

const load = async <T>(key: string, ttlMs: number, loader: () => Promise<T>, tags: CacheTags<T> | undefined): Promise<T> => {
  const redisKey = `${KEY_PREFIX}${key}`;
  try {
    const raw = await withDeadline(cacheRedis.get(redisKey));
    if (raw !== null) {
      const envelope = Envelope.safeParse(JSON.parse(raw));
      if (envelope.success && envelope.data.e > Date.now()) {
        const value = envelope.data.v as T;
        cacheEvents.inc({ event: "hit_redis" });
        setLocal(key, value, envelope.data.e, typeof tags === "function" ? tags(value) : (tags ?? []));
        return value;
      }
    }
  } catch (err) {
    cacheEvents.inc({ event: "error" });
    logger.warn({ err, key }, "cache read failed");
  }
  cacheEvents.inc({ event: "miss" });
  const value = await loader();
  const expiresAt = Date.now() + ttlMs;
  const keyTags = typeof tags === "function" ? tags(value) : (tags ?? []);
  setLocal(key, value, expiresAt, keyTags);
  // Populating the shared tier must not be on the response path: the value is already in the
  // local LRU and on its way to the client, so a slow or down Redis costs the request nothing.
  const pipeline = cacheRedis.pipeline();
  pipeline.set(redisKey, JSON.stringify({ e: expiresAt, v: value }), "PX", ttlMs);
  for (const tag of keyTags) {
    pipeline.sadd(`${TAG_PREFIX}${tag}`, redisKey);
    pipeline.expire(`${TAG_PREFIX}${tag}`, TAG_TTL_SECONDS);
  }
  void withDeadline(pipeline.exec()).catch((err: unknown) => {
    cacheEvents.inc({ event: "error" });
    logger.warn({ err, key }, "cache write failed");
  });
  return value;
};

/**
 * Reads `key` through both cache tiers, loading it at most once per instance at a time.
 * `tags` may be static or derived from the loaded value (the app id is only known after load).
 */
export const cached = <T>(key: string, ttlMs: number, loader: () => Promise<T>, tags?: CacheTags<T>): Promise<T> => {
  const hit = local.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    cacheEvents.inc({ event: "hit_local" });
    local.delete(key);
    local.set(key, hit);
    return Promise.resolve(hit.value as T);
  }
  const pending = inflight.get(key);
  if (pending) {
    cacheEvents.inc({ event: "single_flight" });
    return pending as Promise<T>;
  }
  const run = (async () => {
    try {
      return await load(key, ttlMs, loader, tags);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
};

/** Drops every key carrying any of `tags`, in this process and in Redis, immediately. */
export const invalidateTags = async (tags: string[]): Promise<void> => {
  let dropped = 0;
  for (const tag of tags) {
    const keys = localTags.get(tag);
    if (!keys) continue;
    for (const key of [...keys]) {
      dropLocal(key);
      dropped++;
    }
  }
  cacheLocalEntries.set({}, local.size);
  try {
    const members = await withDeadline(Promise.all(tags.map((tag) => cacheRedis.smembers(`${TAG_PREFIX}${tag}`))));
    const pipeline = cacheRedis.pipeline();
    let queued = 0;
    for (let i = 0; i < tags.length; i++) {
      const redisKeys = members[i] ?? [];
      if (redisKeys.length > 0) {
        pipeline.del(...redisKeys);
        queued += redisKeys.length;
      }
      pipeline.del(`${TAG_PREFIX}${tags[i]!}`);
    }
    if (tags.length > 0) await withDeadline(pipeline.exec());
    dropped += queued;
  } catch (err) {
    cacheEvents.inc({ event: "error" });
    logger.warn({ err, tags }, "cache invalidation failed");
  }
  if (dropped > 0) cacheEvents.inc({ event: "invalidate" }, dropped);
};

const GlobalFeedMessage = z.object({ appId: z.string().min(1) });

/**
 * `feed:*global*` fires whenever an app's ranking inputs change. Every api instance receives it,
 * so each drops its own LRU entries while the first one to get there clears the Redis tier: an
 * app's page and the leaderboard go stale immediately instead of after their TTL.
 */
subscribeChannel(GLOBAL_FEED_CHANNEL, (message) => {
  let appId: string;
  try {
    const parsed = GlobalFeedMessage.safeParse(JSON.parse(message));
    if (!parsed.success) return;
    appId = parsed.data.appId;
  } catch {
    return;
  }
  invalidateTags([APPS_TAG, appTag(appId)]).catch((err: unknown) =>
    logger.warn({ err, appId }, "cache invalidation on global feed failed"),
  );
});
