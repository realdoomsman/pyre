import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * External-wallet login. The challenge is a Redis-backed nonce bound to the address; verify
 * rebuilds the exact EIP-191 message, consumes the challenge, and recovers the signer with viem.
 * The properties that matter: a real signature over the issued message logs in exactly once, a
 * signature by another key (or over a stale/foreign challenge) never does, and a Redis outage
 * refuses logins instead of opening a replay window.
 */

const store = vi.hoisted(() => {
  const kv = new Map<string, string>();
  const state = { down: false };
  return {
    kv,
    state,
    set: vi.fn(async (key: string, value: string) => {
      if (state.down) throw new Error("redis down");
      kv.set(key, value);
      return "OK";
    }),
    getdel: vi.fn(async (key: string) => {
      if (state.down) throw new Error("redis down");
      const v = kv.get(key) ?? null;
      kv.delete(key);
      return v;
    }),
  };
});

vi.mock("../src/lib/redis.js", () => ({ redis: { set: store.set, getdel: store.getdel } }));

import { challengeMessage, verifyWalletLogin, walletChallenge } from "../src/lib/wallet.js";

const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const mallory = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

beforeEach(() => {
  store.kv.clear();
  store.state.down = false;
});

describe("wallet challenge", () => {
  it("issues a message bound to the checksummed address and stores one live challenge per address", async () => {
    const c = await walletChallenge(alice.address.toLowerCase());
    expect(c.message).toBe(challengeMessage(alice.address, c.nonce, c.issued));
    expect(c.message.startsWith(`Pyre sign-in\nAddress: ${alice.address}\nNonce: `)).toBe(true);
    expect(store.set).toHaveBeenCalledWith(`walletchal:${alice.address}`, `${c.nonce} ${c.issued}`, "EX", 300);
    const again = await walletChallenge(alice.address);
    expect(again.nonce).not.toBe(c.nonce);
    expect(store.kv.size).toBe(1);
  });
});

describe("wallet verify", () => {
  it("accepts the owner's EIP-191 signature over the issued message, once", async () => {
    const c = await walletChallenge(alice.address);
    const signature = await alice.signMessage({ message: c.message });
    expect(await verifyWalletLogin(alice.address, signature)).toBe(true);
    // The challenge was consumed: replaying the same signature fails.
    expect(await verifyWalletLogin(alice.address, signature)).toBe(false);
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

  it("rejects when no challenge was issued or it expired", async () => {
    const signature = await alice.signMessage({ message: challengeMessage(alice.address, "deadbeef", new Date().toISOString()) });
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
