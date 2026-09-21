import { randomUUID } from "node:crypto";
import type { Address } from "viem";

/**
 * One transaction at a time per sender. The treasury and every app wallet are signed from two
 * processes (API and runner); a nonce fetched by both before either broadcasts is a replaced or
 * rejected transaction. `withSendLock` serialises `fn` across processes on `lock:send:<address>`:
 * a Redis `SET NX PX` mutex with bounded retry, released by compare-and-delete so an overrun holder
 * cannot drop a successor's lock. Without a configured store the lock is an in-process mutex, which
 * is enough for tests and one-off scripts but NOT for a deployment: both services configure the
 * Redis store at boot.
 */

export interface SendLockStore {
  /** `SET key token NX PX ttlMs`; true when this call took the lock. */
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Delete `key` only while it still holds `token`. */
  release(key: string, token: string): Promise<void>;
}

/** The ioredis surface the Redis store needs; typed structurally so this package stays free of ioredis. */
export interface RedisLike {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<"OK" | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export const redisSendLockStore = (redis: RedisLike): SendLockStore => ({
  acquire: async (key, token, ttlMs) => (await redis.set(key, token, "PX", ttlMs, "NX")) === "OK",
  release: async (key, token) => {
    await redis.eval(RELEASE_LUA, 1, key, token);
  },
});

/** Process-local fallback: a plain mutex per key. */
const memorySendLockStore = (): SendLockStore => {
  const held = new Map<string, string>();
  return {
    acquire: async (key, token) => {
      if (held.has(key)) return false;
      held.set(key, token);
      return true;
    },
    release: async (key, token) => {
      if (held.get(key) === token) held.delete(key);
    },
  };
};

/** Longer than any send + receipt wait (RPC timeout 20 s × 3 retries) so a crashed holder cannot wedge the sender for long. */
export const SEND_LOCK_TTL_MS = 90_000;
/** Callers queue behind each other; past this a sender is considered stuck and the caller fails instead of piling up. */
export const SEND_LOCK_WAIT_MS = 120_000;
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 500;

export const sendLockKey = (address: Address): string => `lock:send:${address.toLowerCase()}`;

export class SendLockTimeoutError extends Error {
  constructor(readonly address: Address) {
    super(`could not take the send lock for ${address} within ${SEND_LOCK_WAIT_MS} ms`);
    this.name = "SendLockTimeoutError";
  }
}

let store: SendLockStore = memorySendLockStore();

/** Installs the cross-process store. Call once at boot, before any transaction is sent. */
export function configureSendLock(next: SendLockStore): void {
  store = next;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding the sender's lock. Not re-entrant: a helper that already holds the lock
 * must not call another locked helper for the same address.
 */
export async function withSendLock<T>(address: Address, fn: () => Promise<T>): Promise<T> {
  const key = sendLockKey(address);
  const token = randomUUID();
  const deadline = Date.now() + SEND_LOCK_WAIT_MS;
  let backoff = RETRY_MIN_MS;
  while (!(await store.acquire(key, token, SEND_LOCK_TTL_MS))) {
    if (Date.now() >= deadline) throw new SendLockTimeoutError(address);
    await sleep(backoff + Math.floor(Math.random() * backoff));
    backoff = Math.min(RETRY_MAX_MS, backoff * 2);
  }
  try {
    return await fn();
  } finally {
    await store.release(key, token);
  }
}
