import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * External-wallet login. The challenge is an EIP-4361 message whose nonce is stored in Redis
 * under the address; verify rebuilds the exact message, validates its domain/URI/chain/time
 * fields, recovers the signer with viem and consumes the nonce. The properties that matter: a
 * real signature over an issued message logs in exactly once, a signature by another key (or
 * over a stale/foreign challenge) never does, several challenges can be live at once, the message
 * is bound to the platform domain and chain, and a Redis outage refuses logins instead of opening
 * a replay window. `WEB_ORIGIN` is `https://pyre.test` for this run.
 */

const store = vi.hoisted(() => {
  const hashes = new Map<string, Map<string, string>>();
  const state = { down: false };
  const guard = (): void => {
    if (state.down) throw new Error("redis down");
  };
  const hash = (key: string): Map<string, string> => {
    let h = hashes.get(key);
    if (!h) {
      h = new Map();
      hashes.set(key, h);
    }
    return h;
  };
  const hdel = vi.fn(async (key: string, ...fields: string[]) => {
    guard();
    let n = 0;
    for (const f of fields) if (hash(key).delete(f)) n++;
    return n;
  });
  const hset = vi.fn(async (key: string, field: string, value: string) => {
    guard();
    hash(key).set(field, value);
    return 1;
  });
  const expire = vi.fn(async () => {
    guard();
    return 1;
  });
  const multi = () => {
    const ops: Array<() => Promise<unknown>> = [];
    const tx = {
      hdel: (key: string, ...fields: string[]) => (ops.push(() => hdel(key, ...fields)), tx),
      hset: (key: string, field: string, value: string) => (ops.push(() => hset(key, field, value)), tx),
      expire: (key: string, ttl: number) => (ops.push(() => expire(key, ttl)), tx),
      exec: async () => {
        const out = [];
        for (const op of ops) out.push([null, await op()]);
        return out;
      },
    };
    return tx;
  };
  return {
    hashes,
    state,
    hdel,
    hset,
    expire,
    hgetall: vi.fn(async (key: string) => {
      guard();
      return Object.fromEntries(hash(key));
    }),
    multi,
  };
});

vi.mock("../src/lib/redis.js", () => ({
  redis: { hgetall: store.hgetall, hdel: store.hdel, hset: store.hset, expire: store.expire, multi: store.multi },
}));

import { CHALLENGE_STATEMENT, challengeMessage, verifyWalletLogin, walletChallenge } from "../src/lib/wallet.js";

const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const mallory = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

const liveNonces = (address: string): string[] => [...(store.hashes.get(`walletsiwe:${address}`)?.keys() ?? [])];

beforeEach(() => {
  store.hashes.clear();
  store.state.down = false;
  vi.useRealTimers();
});

describe("wallet challenge", () => {
  it("issues an EIP-4361 message bound to the platform domain, URI, chain and the checksummed address", async () => {
    const c = await walletChallenge(alice.address.toLowerCase());
    expect(c.message).toBe(challengeMessage(alice.address, c.nonce, c.issued));
    const fields = parseSiweMessage(c.message);
    expect(fields).toMatchObject({
      domain: "pyre.test",
      address: alice.address,
      statement: CHALLENGE_STATEMENT,
      uri: "https://pyre.test",
      version: "1",
      chainId: 4663,
      nonce: c.nonce,
    });
    expect(fields.issuedAt?.toISOString()).toBe(c.issued);
    expect(fields.expirationTime?.toISOString()).toBe(c.expiresAt);
    expect(c.message.startsWith(`pyre.test wants you to sign in with your Ethereum account:\n${alice.address}\n`)).toBe(true);
    expect(store.expire).toHaveBeenCalledWith(`walletsiwe:${alice.address}`, 300);
  });

  it("keeps several challenges live per address so a second tab does not stale the first", async () => {
    const first = await walletChallenge(alice.address);
    const second = await walletChallenge(alice.address);
    expect(second.nonce).not.toBe(first.nonce);
    expect(liveNonces(alice.address)).toEqual(expect.arrayContaining([first.nonce, second.nonce]));
    const signature = await alice.signMessage({ message: first.message });
    expect(await verifyWalletLogin(alice.address, signature)).toBe(true);
  });

  it("evicts the oldest challenge once the live set is full, never growing without bound", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-21T10:00:00.000Z") });
    const issued: string[] = [];
    for (let i = 0; i < 9; i++) {
      issued.push((await walletChallenge(alice.address)).nonce);
      vi.advanceTimersByTime(1_000);
    }
    const live = liveNonces(alice.address);
    expect(live).toHaveLength(8);
    expect(live).not.toContain(issued[0]);
    expect(live).toContain(issued[8]);
  });
});

describe("wallet verify", () => {
  it("accepts the owner's EIP-191 signature over the issued message, once", async () => {
    const c = await walletChallenge(alice.address);
    const signature = await alice.signMessage({ message: c.message });
    expect(await verifyWalletLogin(alice.address, signature)).toBe(true);
    // The challenge was consumed: replaying the same signature fails.
    expect(await verifyWalletLogin(alice.address, signature)).toBe(false);
    expect(liveNonces(alice.address)).toEqual([]);
  });

  it("rejects a signature from a different key", async () => {
    const c = await walletChallenge(alice.address);
    const forged = await mallory.signMessage({ message: c.message });
    expect(await verifyWalletLogin(alice.address, forged)).toBe(false);
  });

  it("rejects a signature over a different address's challenge", async () => {
    const forAlice = await walletChallenge(alice.address);
    await walletChallenge(mallory.address);
    const crossed = await mallory.signMessage({ message: forAlice.message });
    expect(await verifyWalletLogin(mallory.address, crossed)).toBe(false);
  });

  it("rejects a signature over a message that names another domain, chain or URI", async () => {
    const c = await walletChallenge(alice.address);
    for (const [from, to] of [
      ["pyre.test wants", "evil.example wants"],
      ["Chain ID: 4663", "Chain ID: 1"],
      ["URI: https://pyre.test", "URI: https://evil.example"],
    ] as const) {
      const phished = c.message.replace(from, to);
      expect(phished).not.toBe(c.message);
      expect(await verifyWalletLogin(alice.address, await alice.signMessage({ message: phished }))).toBe(false);
    }
    expect(liveNonces(alice.address)).toEqual([c.nonce]);
  });

  it("rejects an expired challenge even when Redis still holds it", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-21T10:00:00.000Z") });
    const c = await walletChallenge(alice.address);
    const signature = await alice.signMessage({ message: c.message });
    vi.setSystemTime(Date.parse("2026-09-21T10:05:01.000Z"));
    expect(await verifyWalletLogin(alice.address, signature)).toBe(false);
  });

  it("rejects when no challenge was issued", async () => {
    const signature = await alice.signMessage({ message: challengeMessage(alice.address, "deadbeefdeadbeef", new Date().toISOString()) });
    expect(await verifyWalletLogin(alice.address, signature)).toBe(false);
  });

  it("fails closed when Redis is unreachable", async () => {
    const c = await walletChallenge(alice.address);
    const signature = await alice.signMessage({ message: c.message });
    store.state.down = true;
    expect(await verifyWalletLogin(alice.address, signature)).toBe(false);
  });

  it("does not throw on garbage signatures", async () => {
    await walletChallenge(alice.address);
    expect(await verifyWalletLogin(alice.address, "0x1234")).toBe(false);
  });
});
