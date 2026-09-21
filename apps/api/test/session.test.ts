import { describe, it, expect, vi } from "vitest";
import { SignJWT } from "jose";

/**
 * Session tokens carry the user's token-version so a logout/compromise bump revokes every
 * outstanding JWT. Backward compat is load-bearing: tokens minted before the `tv` claim existed
 * MUST read as version 0 so a deploy doesn't sign every logged-in user out.
 */
const SECRET = "test-session-secret-value-1234567890";
vi.mock("../src/env.js", () => ({ env: { SESSION_SECRET: SECRET } }));

const { signSession, verifySession } = await import("../src/lib/session.js");

describe("session tokens", () => {
  it("round-trips the subject and token version", async () => {
    const token = await signSession("u1", 7);
    expect(await verifySession(token)).toEqual({ userId: "u1", tokenVersion: 7 });
  });

  it("rejects a malformed or foreign-signed token", async () => {
    expect(await verifySession("not.a.jwt")).toBeNull();
    const foreign = await new SignJWT({ tv: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode("a-different-secret-value-000000000000"));
    expect(await verifySession(foreign)).toBeNull();
  });

  it("reads a legacy token with no tv claim as version 0 (no mass logout on deploy)", async () => {
    const legacy = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u9")
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySession(legacy)).toEqual({ userId: "u9", tokenVersion: 0 });
  });
});
