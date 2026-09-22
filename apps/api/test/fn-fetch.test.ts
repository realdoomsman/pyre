import { describe, expect, it, vi } from "vitest";

/**
 * `ship.fetch` origin allowlist. A deployed function may call other Pyre functions and nothing
 * else: this is the guest's only outbound network capability, so it doubles as the SSRF boundary
 * (metadata endpoints, localhost services, the API's own admin routes). `APP_DOMAIN` is
 * `apps.pyre.test` and `API_ORIGIN` is `https://api.pyre.test` for this run.
 *
 * Redis, prisma and the chain package are faked because `fn.ts` opens a live ioredis connection
 * at import time; nothing here performs I/O.
 */

vi.mock("../src/lib/redis.js", () => ({
  redis: { set: async () => "OK", del: async () => 1, get: async () => null },
  subscribeChannel: () => () => undefined,
  closeRedis: async () => undefined,
}));
vi.mock("@pyre/db", () => ({
  Prisma: { JsonNull: null },
  prisma: { appKv: { findUnique: async () => null } },
}));
vi.mock("@pyre/chain", () => ({}));
vi.mock("../src/lib/treasury.js", () => ({ TREASURY_WALLET: "0x2222222222222222222222222222222222222222" }));

import type { Request } from "express";
import { DEPTH_HEADER, allowedTarget, callDepth, signDepth } from "../src/host/routes/fn.js";

describe("allowedTarget accepts", () => {
  it("a path-routed function on the API origin, naming the target app and function", () => {
    const t = allowedTarget("https://api.pyre.test/a/inboxzero/_pyre/fn/summarize");
    expect(t.url.toString()).toBe("https://api.pyre.test/a/inboxzero/_pyre/fn/summarize");
    expect(t).toMatchObject({ slug: "inboxzero", name: "summarize" });
    expect(allowedTarget("https://api.pyre.test/a/demo/_pyre/fn/hello").url.pathname).toBe("/a/demo/_pyre/fn/hello");
  });

  it("a host-routed function on an app subdomain over TLS", () => {
    const t = allowedTarget("https://inboxzero.apps.pyre.test/_pyre/fn/summarize");
    expect(t.url.host).toBe("inboxzero.apps.pyre.test");
    expect(t).toMatchObject({ slug: "inboxzero", name: "summarize" });
    expect(allowedTarget("https://INBOXZERO.APPS.PYRE.TEST/_pyre/fn/summarize").url.hostname).toBe("inboxzero.apps.pyre.test");
  });

  it("function names with underscores and digits", () => {
    expect(allowedTarget("https://demo.apps.pyre.test/_pyre/fn/do_thing_2").url.pathname).toBe("/_pyre/fn/do_thing_2");
  });
});

describe("callDepth (signed x-pyre-fn-depth)", () => {
  const withHeader = (value?: string): Request => ({ headers: value === undefined ? {} : { [DEPTH_HEADER]: value } }) as unknown as Request;

  it("is 0 for a browser call that carries no header", () => {
    expect(callDepth(withHeader(), "demo", "hello")).toBe(0);
  });

  it("trusts a depth the platform signed for exactly this app and function", () => {
    expect(callDepth(withHeader(signDepth(1, "demo", "hello")), "demo", "hello")).toBe(1);
    expect(callDepth(withHeader(signDepth(2, "demo", "hello")), "demo", "hello")).toBe(2);
  });

  it("refuses a bare depth a browser could send, so it cannot pose as an internal hop", () => {
    expect(() => callDepth(withHeader("1"), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => callDepth(withHeader("0"), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("refuses a signature minted for another target or a tampered depth", () => {
    expect(() => callDepth(withHeader(signDepth(1, "other", "hello")), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => callDepth(withHeader(signDepth(1, "demo", "bye")), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
    const [, issued, mac] = signDepth(1, "demo", "hello").split(".");
    expect(() => callDepth(withHeader(`2.${issued}.${mac}`), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("refuses a depth past the app-to-app ceiling even when signed", () => {
    expect(() => callDepth(withHeader(signDepth(3, "demo", "hello")), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("refuses a stale signature", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });
    try {
      const header = signDepth(1, "demo", "hello");
      vi.setSystemTime(now + 61_000);
      expect(() => callDepth(withHeader(header), "demo", "hello")).toThrow(expect.objectContaining({ status: 403 }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("allowedTarget rejects", () => {
  const reject = (url: string): void => {
    expect(() => allowedTarget(url)).toThrow(/ship\.fetch/);
  };

  it("anything that is not a Pyre function path", () => {
    for (const url of [
      "https://inboxzero.apps.pyre.test/",
      "https://inboxzero.apps.pyre.test/admin",
      "https://inboxzero.apps.pyre.test/_pyre/kv/secret",
      "https://api.pyre.test/a/inboxzero/_pyre/kv/secret",
      "https://api.pyre.test/admin/apps",
      "https://api.pyre.test/_pyre/fn/summarize", // the API origin itself is not an app host
      "https://api.pyre.test/a/inboxzero/_pyre/fn/summarize/extra",
    ]) {
      reject(url);
    }
  });

  it("foreign origins, including SSRF favourites", () => {
    for (const url of [
      "https://evil.test/_pyre/fn/steal",
      "https://apps.pyre.test/_pyre/fn/x", // bare app domain, no slug
      "https://inboxzero.apps.pyre.test.evil.test/_pyre/fn/x",
      "http://169.254.169.254/_pyre/fn/x",
      "https://169.254.169.254/latest/meta-data/",
      "http://localhost:6379/_pyre/fn/x",
      "http://127.0.0.1/_pyre/fn/x",
      "https://metadata.google.internal/_pyre/fn/x",
    ]) {
      reject(url);
    }
  });

  it("non-TLS app hosts, so a function cannot be downgraded onto plaintext", () => {
    reject("http://inboxzero.apps.pyre.test/_pyre/fn/summarize");
  });

  it("non-http schemes and malformed URLs", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://apps.pyre.test/_pyre/fn/x",
      "javascript:alert(1)",
      "data:text/plain,hello",
      "not a url",
      "",
      "//inboxzero.apps.pyre.test/_pyre/fn/x",
      "/a/inboxzero/_pyre/fn/summarize",
    ]) {
      reject(url);
    }
  });

  it("query strings, fragments and credentials smuggled into the URL", () => {
    for (const url of [
      "https://inboxzero.apps.pyre.test/_pyre/fn/summarize?x=1",
      "https://inboxzero.apps.pyre.test/_pyre/fn/summarize#frag",
      "https://api.pyre.test/a/demo/_pyre/fn/hello?redirect=https://evil.test",
      "https://user:pass@evil.test/_pyre/fn/x",
    ]) {
      reject(url);
    }
  });

  it("slugs and function names outside the allowed character sets", () => {
    for (const url of [
      "https://UPPER_SLUG.apps.pyre.test/_pyre/fn/x",
      "https://bad_slug.apps.pyre.test/_pyre/fn/x",
      "https://deep.nested.apps.pyre.test/_pyre/fn/x",
      `https://${"x".repeat(41)}.apps.pyre.test/_pyre/fn/y`,
      "https://demo.apps.pyre.test/_pyre/fn/Bad-Name-With-Caps",
      "https://demo.apps.pyre.test/_pyre/fn/",
      `https://demo.apps.pyre.test/_pyre/fn/${"n".repeat(41)}`,
      "https://api.pyre.test/a/BAD/_pyre/fn/x",
      "https://api.pyre.test/a//_pyre/fn/x",
    ]) {
      reject(url);
    }
  });

  it("path traversal aimed at escaping the function prefix", () => {
    for (const url of [
      "https://demo.apps.pyre.test/_pyre/fn/../kv/secret",
      "https://demo.apps.pyre.test/_pyre/fn/%2e%2e/kv",
      "https://api.pyre.test/a/demo/_pyre/fn/..%2f..%2fadmin",
    ]) {
      reject(url);
    }
  });
});
