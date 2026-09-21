import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";

/**
 * Pre-auth rate-limit identity. The guard runs before `requireAuth`, so the identities it charges
 * must be things an attacker cannot mint for free: the client IP is always charged, a bearer token
 * only adds a bucket once its HS256 signature verifies, and a self-chosen `address` in the body
 * only adds a bucket on the wallet-login routes (and never replaces the IP one).
 */

vi.mock("../src/lib/redis.js", () => ({
  redis: { defineCommand: () => undefined },
  subscribeChannel: () => () => undefined,
  closeRedis: async () => undefined,
}));

import { callerIdentities } from "../src/lib/ratelimit.js";
import { signSession } from "../src/lib/session.js";

const request = (over: Partial<{ path: string; ip: string; authorization: string; body: unknown; user: { id: string } }> = {}): Request =>
  ({
    path: over.path ?? "/rpc",
    ip: over.ip ?? "203.0.113.7",
    socket: { remoteAddress: over.ip ?? "203.0.113.7" },
    headers: over.authorization === undefined ? {} : { authorization: over.authorization },
    body: over.body,
    user: over.user,
  }) as unknown as Request;

describe("callerIdentities", () => {
  it("charges the IP for an anonymous request", async () => {
    expect(await callerIdentities(request())).toEqual(["ip:203.0.113.7"]);
  });

  it("ignores an unverifiable bearer token: rotating fake tokens never mints new buckets", async () => {
    expect(await callerIdentities(request({ authorization: "Bearer not-a-jwt" }))).toEqual(["ip:203.0.113.7"]);
    expect(await callerIdentities(request({ authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad" }))).toEqual(["ip:203.0.113.7"]);
    expect(await callerIdentities(request({ authorization: "Bearer " }))).toEqual(["ip:203.0.113.7"]);
  });

  it("adds the user bucket for a validly signed session, alongside the IP", async () => {
    const token = await signSession("user_42", 0);
    expect(await callerIdentities(request({ authorization: `Bearer ${token}` }))).toEqual(["ip:203.0.113.7", "u:user_42"]);
  });

  it("uses the already-authenticated user when present", async () => {
    expect(await callerIdentities(request({ user: { id: "user_7" } }))).toEqual(["ip:203.0.113.7", "u:user_7"]);
  });

  it("ignores a body address outside the wallet-login routes", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [], address: "0x1111111111111111111111111111111111111111" };
    expect(await callerIdentities(request({ path: "/rpc", body }))).toEqual(["ip:203.0.113.7"]);
    expect(await callerIdentities(request({ path: "/auth/google", body }))).toEqual(["ip:203.0.113.7"]);
  });

  it("keys wallet-login routes by the claimed address in addition to the IP", async () => {
    const body = { address: "0xAbC1111111111111111111111111111111111111" };
    expect(await callerIdentities(request({ path: "/auth/wallet/challenge", body }))).toEqual([
      "ip:203.0.113.7",
      "w:0xabc1111111111111111111111111111111111111",
    ]);
    expect(await callerIdentities(request({ path: "/auth/wallet/verify", body: { address: "nope" } }))).toEqual(["ip:203.0.113.7"]);
  });
});
