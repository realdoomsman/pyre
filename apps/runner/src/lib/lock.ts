import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * Redis mutexes for the repeatable worker passes. Every side-effecting pass runs
 * under one so a second runner instance skips instead of double-sweeping,
 * double-charging or double-building.
 *
 * The lock is `SET key <token> EX ttl NX`; release is a compare-and-delete on the
 * token so a holder that overran its TTL cannot delete a successor's lock.
 */

/** `EVAL` compare-and-delete: only the owner of `token` releases the key. */
const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
/** `EVAL` compare-and-expire: only the owner of `token` extends the key. */
const RENEW_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end`;

export interface LockHandle {
  key: string;
  token: string;
  /** Extend the TTL. Returns false when the lock was lost (expired or stolen). */
  renew: (ttlSeconds?: number) => Promise<boolean>;
  /** Compare-and-delete. Returns false when the lock was already lost. */
  release: () => Promise<boolean>;
}

export type LockOutcome<T> =
  /** The lock was taken and `fn` ran. */
  | { acquired: true; value: T }
  /** Another holder owns the lock; `fn` did not run. */
  | { acquired: false; heldBy: string | null };

export interface AcquireOpts {
  /**
   * Keep the lock alive while the caller works: renews every `ttlSeconds / 3`
   * until `release()`. For holders (a build) whose duration is not bounded by a
   * TTL that is safe to lose.
   */
  autoRenew?: boolean;
}

/** Extend `key` by `ttlSeconds` when `token` still owns it. */
export const renewLock = async (redis: Redis, key: string, token: string, ttlSeconds: number): Promise<boolean> => {
  const res = await redis.eval(RENEW_LUA, 1, key, token, String(ttlSeconds));
  return res === 1;
};

/** Release `key` when `token` still owns it. */
export const releaseLock = async (redis: Redis, key: string, token: string): Promise<boolean> => {
  const res = await redis.eval(RELEASE_LUA, 1, key, token);
  return res === 1;
};

/**
 * Take `key` for `ttlSeconds`, or return null when someone else holds it.
 * Callers MUST `release()` in a `finally`.
 */
export const acquireLock = async (
  redis: Redis,
  key: string,
  ttlSeconds: number,
  opts: AcquireOpts = {},
): Promise<LockHandle | null> => {
  const token = randomUUID();
  if ((await redis.set(key, token, "EX", ttlSeconds, "NX")) !== "OK") return null;

  let timer: NodeJS.Timeout | undefined;
  const renew = async (ttl = ttlSeconds): Promise<boolean> => renewLock(redis, key, token, ttl);
  if (opts.autoRenew) {
    timer = setInterval(() => {
      void renew().catch(() => undefined);
    }, Math.max(1_000, Math.floor((ttlSeconds * 1000) / 3)));
    timer.unref();
  }
  return {
    key,
    token,
    renew,
    release: async () => {
      clearInterval(timer);
      return releaseLock(redis, key, token);
    },
  };
};

/**
 * Run `fn` under the lock `key`. When another holder owns it, `fn` is not run and
 * the caller gets `{ acquired: false }` so it can log "skipped, lock held" instead
 * of silently doing nothing.
 */
export const withLock = async <T>(
  redis: Redis,
  key: string,
  ttlSeconds: number,
  fn: (lock: LockHandle) => Promise<T>,
  opts: AcquireOpts = {},
): Promise<LockOutcome<T>> => {
  const lock = await acquireLock(redis, key, ttlSeconds, opts);
  if (!lock) return { acquired: false, heldBy: await redis.get(key) };
  try {
    return { acquired: true, value: await fn(lock) };
  } finally {
    await lock.release();
  }
};
