import type { Request, Response } from "express";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REFUND_LINK_TTL_SECONDS, REFUND_RELINK_COOLDOWN_SECONDS, REFUND_SNAPSHOT } from "@pyre/shared";

/**
 * PYRE refund wallet linking. A snapshot holder links the Solana wallet refunds are paid to by
 * having BOTH wallets sign the same server-issued message: the Robinhood Chain address (EIP-191, or
 * a custodial session that owns it) and the Solana wallet (ed25519). What matters: each nonce links
 * at most once, a signature by the wrong key — or over a challenge issued for another Solana wallet —
 * never links, a session only stands in for the EVM proof when its custodial wallet IS the address,
 * and only holders still owed something can start a link. Real keys and real signatures throughout.
 */

const fx = vi.hoisted(() => {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string): Map<string, string> => {
    let h = hashes.get(key);
    if (!h) hashes.set(key, (h = new Map()));
    return h;
  };
  const hdel = async (key: string, ...fields: string[]) => fields.filter((f) => hash(key).delete(f)).length;
  const hset = async (key: string, field: string, value: string) => (hash(key).set(field, value), 1);
  const redis = {
    hgetall: async (key: string) => Object.fromEntries(hash(key)),
    hget: async (key: string, field: string) => hash(key).get(field) ?? null,
    hdel,
    hset,
    expire: async () => 1,
    defineCommand: () => undefined,
    multi: () => {
      const ops: Array<() => Promise<unknown>> = [];
      const tx = {
        hdel: (k: string, ...f: string[]) => (ops.push(() => hdel(k, ...f)), tx),
        hset: (k: string, f: string, v: string) => (ops.push(() => hset(k, f, v)), tx),
        expire: () => tx,
        exec: async () => Promise.all(ops.map((op) => op())),
      };
      return tx;
    },
  };
  interface Holder {
    address: string;
    balanceUnits: string;
    currentBalanceUnits: string;
    minBalanceUnits: string;
    boughtUnits: string;
    ethInWei: string;
    ethOutWei: string;
    owedWei: string;
    settledWei: string;
    creditMicros: bigint;
    paidMicros: bigint;
    solWallet: string | null;
    linkedAt: Date | null;
    linkedByUserId: string | null;
    linkPendingUntil: Date | null;
  }
  const holders = new Map<string, Holder>();
  const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
  const prisma = {
    refundHolder: {
      findUnique: async ({ where, include }: { where: { address: string }; include?: unknown }) => {
        const h = holders.get(where.address);
        return h ? { ...h, ...(include ? { payouts: [] } : {}) } : null;
      },
      update: async ({ where, data }: { where: { address: string }; data: Partial<Holder> }) => {
        const h = holders.get(where.address)!;
        Object.assign(h, data);
        return h;
      },
    },
    auditLog: { create: async () => ({}) },
  };
  return { hashes, redis, holders, audits, prisma, erc1271: vi.fn(async () => false) };
});

vi.mock("../src/lib/redis.js", () => ({ redis: fx.redis }));
vi.mock("@pyre/db", () => ({ prisma: fx.prisma, big: (v: unknown) => BigInt(String(v)) }));
vi.mock("@pyre/chain", () => ({ publicClient: () => ({ verifyMessage: fx.erc1271 }) }));
vi.mock("../src/lib/audit.js", () => ({
  writeAudit: async (e: { action: string; meta: Record<string, unknown> }) => void fx.audits.push(e),
}));
vi.mock("../src/lib/cache.js", () => ({ cached: <T,>(_k: unknown, _ttl: unknown, fn: () => Promise<T>) => fn() }));

import { challengeHandler, holderDto, linkHandler } from "../src/routes/refund.js";

const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const mallory = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const solKey = ed25519.utils.randomPrivateKey();
const solWallet = bs58.encode(ed25519.getPublicKey(solKey));
const otherSolKey = ed25519.utils.randomPrivateKey();
const otherSolWallet = bs58.encode(ed25519.getPublicKey(otherSolKey));

const solSign = (key: Uint8Array, message: string): string => Buffer.from(ed25519.sign(new TextEncoder().encode(message), key)).toString("base64");

const call = async (handler: (req: Request, res: Response) => Promise<void>, body: unknown, user?: unknown, ip = "203.0.113.7"): Promise<any> => {
  let out: unknown;
  const res = { json: (b: unknown) => ((out = b), res), status: () => res } as unknown as Response;
  await handler({ body, user, params: {}, ip, socket: { remoteAddress: ip } } as unknown as Request, res);
  return out;
};

const challenge = (sol = solWallet, ip?: string) => call(challengeHandler, { address: alice.address, solWallet: sol }, undefined, ip);
const link = async (c: { message: string; nonce: string }, sol = solWallet, key = solKey) =>
  call(linkHandler, { address: alice.address, solWallet: sol, nonce: c.nonce, solSignature: solSign(key, c.message), evmSignature: await alice.signMessage({ message: c.message }) });

beforeEach(() => {
  fx.hashes.clear();
  fx.audits.length = 0;
  fx.holders.clear();
  fx.erc1271.mockClear();
  fx.holders.set(alice.address, {
    address: alice.address,
    balanceUnits: "1000",
    currentBalanceUnits: "1000",
    minBalanceUnits: "1000",
    boughtUnits: "1000",
    ethInWei: "3000000000000000000",
    ethOutWei: "1000000000000000000",
    owedWei: "2000000000000000000",
    settledWei: "0",
    creditMicros: 0n,
    paidMicros: 0n,
    solWallet: null,
    linkedAt: null,
    linkedByUserId: null,
    linkPendingUntil: null,
  });
});

describe("refund link challenge", () => {
  it("refuses addresses that are not in the snapshot or are owed nothing", async () => {
    await expect(call(challengeHandler, { address: mallory.address, solWallet })).rejects.toMatchObject({ status: 404, message: "not_eligible" });
    fx.holders.get(alice.address)!.owedWei = "0";
    await expect(challenge()).rejects.toMatchObject({ status: 404, message: "not_eligible" });
  });

  it("refuses holders who sold or moved all their snapshot PYRE, even if they bought back", async () => {
    Object.assign(fx.holders.get(alice.address)!, { minBalanceUnits: "0", currentBalanceUnits: "5000" });
    await expect(challenge()).rejects.toMatchObject({ status: 404, message: "not_eligible" });
  });

  it("refuses Solana wallets that are not a 32-byte on-curve key", async () => {
    await expect(challenge("not-base58-0OIl")).rejects.toMatchObject({ status: 400, message: "bad_sol_wallet" });
    await expect(challenge(bs58.encode(new Uint8Array(31).fill(7)))).rejects.toMatchObject({ status: 400, message: "bad_sol_wallet" });
    // y = 2 has no x on edwards25519.
    const offCurve = new Uint8Array(32);
    offCurve[0] = 2;
    await expect(challenge(bs58.encode(offCurve))).rejects.toMatchObject({ status: 400, message: "bad_sol_wallet" });
  });

  it("never evicts another requester's live nonce, however many challenges are issued for the address", async () => {
    const mine = await challenge(solWallet, "198.51.100.1");
    for (let i = 0; i < 20; i++) await challenge(otherSolWallet, "203.0.113.7");
    expect((await link(mine)).solWallet).toBe(solWallet);
  });

  it("keeps at most a few live nonces per requester, evicting that requester's oldest", async () => {
    const first = await challenge();
    for (let i = 0; i < 4; i++) await challenge();
    await expect(link(first)).rejects.toMatchObject({ status: 409, message: "challenge_expired" });
  });
});

describe("refund link message", () => {
  it("is an EIP-4361 message for the web origin naming the Solana wallet and the snapshot block", async () => {
    const c = await challenge();
    expect(c.message.startsWith(`pyre.test wants you to sign in with your Ethereum account:\n${alice.address}\n`)).toBe(true);
    expect(c.message).toContain(`Link Solana wallet ${solWallet} as the payout wallet`);
    expect(c.message).toContain(`snapshot block ${REFUND_SNAPSHOT.block}`);
    expect(c.message).toContain("URI: https://pyre.test");
    expect(c.message).toContain(`Chain ID: ${REFUND_SNAPSHOT.chainId}`);
    expect(c.message).toContain(`Expiration Time: ${c.expiresAt}`);
  });

  it("refuses a challenge past its expiration time even when the nonce is still stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const c = await challenge();
      vi.setSystemTime(Date.now() + (REFUND_LINK_TTL_SECONDS + 1) * 1000);
      await expect(link(c)).rejects.toMatchObject({ status: 409, message: "challenge_expired" });
      expect(fx.holders.get(alice.address)!.solWallet).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refund link", () => {
  it("links with EVM + Solana signatures exactly once", async () => {
    const c = await challenge();
    const body = { address: alice.address, solWallet, nonce: c.nonce, solSignature: solSign(solKey, c.message), evmSignature: await alice.signMessage({ message: c.message }) };
    const dto = await call(linkHandler, body);
    expect(dto.solWallet).toBe(solWallet);
    expect(dto.linkPendingUntil).toBeNull();
    expect(fx.holders.get(alice.address)!.linkedByUserId).toBeNull();
    expect(fx.audits).toEqual([expect.objectContaining({ action: "REFUND_LINK", meta: { address: alice.address, from: null, to: solWallet, via: "evm", payoutsFrom: null } })]);

    await expect(call(linkHandler, body)).rejects.toMatchObject({ status: 409, message: "challenge_expired" });
  });

  it("holds payouts to a different wallet for the relink cooldown; re-proving the same wallet changes nothing", async () => {
    await link(await challenge());
    expect(fx.holders.get(alice.address)!.linkPendingUntil).toBeNull();

    const before = Date.now();
    const relinked = await link(await challenge(otherSolWallet), otherSolWallet, otherSolKey);
    expect(relinked.solWallet).toBe(otherSolWallet);
    const until = Date.parse(relinked.linkPendingUntil);
    expect(until).toBeGreaterThanOrEqual(before + REFUND_RELINK_COOLDOWN_SECONDS * 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + REFUND_RELINK_COOLDOWN_SECONDS * 1000);
    expect(fx.audits.at(-1)?.meta).toMatchObject({ from: solWallet, to: otherSolWallet, payoutsFrom: relinked.linkPendingUntil });

    // Re-proving the wallet now linked neither lifts nor restarts the cooldown.
    const again = await link(await challenge(otherSolWallet), otherSolWallet, otherSolKey);
    expect(again.linkPendingUntil).toBe(relinked.linkPendingUntil);
  });

  it("rejects a Solana signature from a different key", async () => {
    const c = await challenge();
    const body = { address: alice.address, solWallet, nonce: c.nonce, solSignature: solSign(otherSolKey, c.message), evmSignature: await alice.signMessage({ message: c.message }) };
    await expect(call(linkHandler, body)).rejects.toMatchObject({ status: 401, message: "bad_sol_signature" });
    expect(fx.holders.get(alice.address)!.solWallet).toBeNull();
  });

  it("rejects signatures over a challenge issued for another Solana wallet", async () => {
    const c = await challenge(otherSolWallet);
    // Both wallets sign the other-wallet message; the request claims the first wallet.
    const body = { address: alice.address, solWallet, nonce: c.nonce, solSignature: solSign(solKey, c.message), evmSignature: await alice.signMessage({ message: c.message }) };
    await expect(call(linkHandler, body)).rejects.toMatchObject({ status: 409, message: "challenge_expired" });
    expect(fx.holders.get(alice.address)!.solWallet).toBeNull();
  });

  it("rejects an EVM signature by another address", async () => {
    const c = await challenge();
    const body = { address: alice.address, solWallet, nonce: c.nonce, solSignature: solSign(solKey, c.message), evmSignature: await mallory.signMessage({ message: c.message }) };
    await expect(call(linkHandler, body)).rejects.toMatchObject({ status: 401, message: "bad_evm_signature" });
    expect(fx.erc1271).toHaveBeenCalled();
  });

  it("accepts a custodial session in place of the EVM signature only when its wallet is the address", async () => {
    const c1 = await challenge();
    const stranger = { id: "u2", wallet: mallory.address };
    await expect(
      call(linkHandler, { address: alice.address, solWallet, nonce: c1.nonce, solSignature: solSign(solKey, c1.message) }, stranger),
    ).rejects.toMatchObject({ status: 401, message: "bad_evm_signature" });

    const c2 = await challenge();
    const owner = { id: "u1", wallet: alice.address };
    const dto = await call(linkHandler, { address: alice.address, solWallet, nonce: c2.nonce, solSignature: solSign(solKey, c2.message) }, owner);
    expect(dto.solWallet).toBe(solWallet);
    expect(fx.holders.get(alice.address)!.linkedByUserId).toBe("u1");
    expect(fx.audits.at(-1)?.meta.via).toBe("custodial");
  });
});

describe("holder dto", () => {
  it("reports remaining as eligible minus settled", () => {
    const h = { ...fx.holders.get(alice.address)!, settledWei: "750000000000000000" };
    const dto = holderDto(h as never, []);
    expect(dto.remainingWei).toBe("1250000000000000000");
    expect(dto.eligibleWei).toBe("2000000000000000000");
    expect(dto.stillHolding).toBe(true);
  });

  it("shrinks a partial seller's refund to the lowest balance held, ignoring buybacks", () => {
    // Sold 700 of 1000 after the snapshot (min 300), then bought up to 1200.
    const h = { ...fx.holders.get(alice.address)!, minBalanceUnits: "300", currentBalanceUnits: "1200", settledWei: "100000000000000000" };
    const dto = holderDto(h as never, []);
    expect(dto.owedWei).toBe("2000000000000000000");
    expect(dto.eligibleWei).toBe("600000000000000000");
    expect(dto.remainingWei).toBe("500000000000000000");
    expect(dto.stillHolding).toBe(false);
    expect(dto.currentBalanceUnits).toBe("1200");
    expect(dto.minBalanceUnits).toBe("300");
  });

  it("never reports negative remaining when settled already exceeds the shrunken eligibility", () => {
    const h = { ...fx.holders.get(alice.address)!, minBalanceUnits: "100", settledWei: "1000000000000000000" };
    expect(holderDto(h as never, []).remainingWei).toBe("0");
  });
});
