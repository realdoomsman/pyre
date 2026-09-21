import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSendLock, redisSendLockStore, sendLockKey, withSendLock, type RedisLike, type SendLockStore } from "./sendLock.js";

/**
 * `withSendLock` is what stops the API and the runner from broadcasting two transactions with the
 * same nonce from one key: whichever store backs it, callers for one address must run one at a
 * time, callers for different addresses must not wait on each other, and the lock must be released
 * on both success and failure. The Redis store is checked against a minimal in-memory `SET NX PX`
 * + compare-and-delete double; the retry backoff runs on fake timers.
 */

const A = "0x00000000000000000000000000000000000000Aa" as const;
const B = "0x00000000000000000000000000000000000000Bb" as const;

/** Enough of ioredis to exercise the real store: `SET key value PX ttl NX` and the release script. */
const fakeRedis = (): RedisLike & { keys: Map<string, string> } => {
  const keys = new Map<string, string>();
  return {
    keys,
    set: async (key, value, _px, _ttl, _nx) => {
      if (keys.has(key)) return null;
      keys.set(key, value);
      return "OK";
    },
    eval: async (_script, _n, key, token) => {
      if (keys.get(key) === token) {
        keys.delete(key);
        return 1;
      }
      return 0;
    },
  };
};

/** Flushes pending promise callbacks without advancing the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("withSendLock", () => {
  it("serialises sends for one address and lets other addresses proceed", async () => {
    const redis = fakeRedis();
    configureSendLock(redisSendLockStore(redis));
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = withSendLock(A, async () => {
      order.push("a1:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("a1:end");
    });
    await flush();
    const second = withSendLock(A, async () => {
      order.push("a2");
    });
    const other = withSendLock(B, async () => {
      order.push("b");
    });
    await flush();
    // B is not queued behind A's holder; A's second caller is, retrying with backoff.
    expect(order).toEqual(["a1:start", "b"]);
    expect(redis.keys.get(sendLockKey(A))).toBeDefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(order).toEqual(["a1:start", "b"]);
    releaseFirst();
    await vi.runAllTimersAsync();
    await Promise.all([first, second, other]);
    expect(order).toEqual(["a1:start", "b", "a1:end", "a2"]);
    expect(redis.keys.size).toBe(0);
  });

  it("releases the lock when the send throws, so the next caller is not wedged", async () => {
    const redis = fakeRedis();
    configureSendLock(redisSendLockStore(redis));
    await expect(withSendLock(A, async () => Promise.reject(new Error("reverted")))).rejects.toThrow("reverted");
    expect(redis.keys.size).toBe(0);
    await expect(withSendLock(A, async () => "ok")).resolves.toBe("ok");
  });

  it("only the holder's token can release the key", async () => {
    const redis = fakeRedis();
    const store: SendLockStore = redisSendLockStore(redis);
    expect(await store.acquire("k", "t1", 1000)).toBe(true);
    expect(await store.acquire("k", "t2", 1000)).toBe(false);
    await store.release("k", "t2");
    expect(redis.keys.get("k")).toBe("t1");
    await store.release("k", "t1");
    expect(redis.keys.has("k")).toBe(false);
  });
});
