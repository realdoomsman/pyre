import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/errors.js";
import { enforceSameOrigin, type OriginPolicy } from "../src/lib/origin.js";
import { applySecurityHeaders } from "../src/host/headers.js";
import { createSessionCookie, verifySessionCookie } from "../src/host/session.js";

/**
 * Isolation between apps that share the API origin (`/a/<slug>` routing). Two layers: the app
 * session cookie is bound to the app it was minted for, and a `/_pyre/*` request must prove
 * which app's page sent it — `X-Pyre-App` when present must name the resolved app, and a
 * credentialed mutation on a path-routed app must carry that header or a referer under its own
 * base path (app pages send `Referrer-Policy: same-origin`, so same-origin fetches carry one).
 */

const request = (method: string, headers: Record<string, string> = {}): Request => ({ method, headers }) as unknown as Request;

const pathRouted = (over: Partial<OriginPolicy> = {}): OriginPolicy => ({
  origin: "https://api.pyre.test",
  basePath: "/a/victim",
  appId: "app_victim",
  credentialed: true,
  ...over,
});

const hostRouted = (over: Partial<OriginPolicy> = {}): OriginPolicy => ({
  origin: "https://victim.apps.pyre.test",
  basePath: "",
  appId: "app_victim",
  credentialed: true,
  ...over,
});

const reason = (req: Request, policy: OriginPolicy): string | null => {
  try {
    enforceSameOrigin(req, policy);
    return null;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return String(err.extra?.reason);
  }
};

describe("app session cookie", () => {
  it("only verifies for the app it was minted for", () => {
    const cookie = createSessionCookie("user_1", "app_x");
    expect(verifySessionCookie(cookie, "app_x")).toBe("user_1");
    expect(verifySessionCookie(cookie, "app_y")).toBeNull();
  });

  it("cannot be rebound to another app by editing the app id, because the MAC covers it", () => {
    const [userId, , exp, mac] = createSessionCookie("user_1", "app_x").split(".");
    expect(verifySessionCookie(`${userId}.app_y.${exp}.${mac}`, "app_y")).toBeNull();
  });
});

describe("enforceSameOrigin on the shared path-routed origin", () => {
  it("accepts a same-origin fetch from the app's own page (referer under its base path)", () => {
    const req = request("POST", { origin: "https://api.pyre.test", referer: "https://api.pyre.test/a/victim/checkout" });
    expect(reason(req, pathRouted())).toBeNull();
    expect(reason(request("POST", { origin: "https://api.pyre.test", referer: "https://api.pyre.test/a/victim" }), pathRouted())).toBeNull();
  });

  it("accepts a same-origin fetch that names the app with X-Pyre-App, even without a referer", () => {
    const req = request("POST", { origin: "https://api.pyre.test", "x-pyre-app": "app_victim" });
    expect(reason(req, pathRouted())).toBeNull();
  });

  it("rejects a credentialed mutation from another app's page on the same origin", () => {
    const req = request("POST", { origin: "https://api.pyre.test", referer: "https://api.pyre.test/a/evil/index.html" });
    expect(reason(req, pathRouted())).toBe("referer_outside_app");
    // A prefix that merely starts with the slug is still outside the app.
    expect(reason(request("POST", { origin: "https://api.pyre.test", referer: "https://api.pyre.test/a/victim-evil/" }), pathRouted())).toBe("referer_outside_app");
  });

  it("rejects a credentialed same-origin mutation that proves no page at all", () => {
    // The pre-fix bypass: Origin matches the shared API origin, no referer, no app header.
    expect(reason(request("POST", { origin: "https://api.pyre.test" }), pathRouted())).toBe("app_unproven");
    expect(reason(request("POST", { "sec-fetch-site": "same-origin" }), pathRouted())).toBe("app_unproven");
  });

  it("rejects any request whose X-Pyre-App names a different app, reads included", () => {
    const headers = { origin: "https://api.pyre.test", referer: "https://api.pyre.test/a/victim/", "x-pyre-app": "app_evil" };
    expect(reason(request("POST", headers), pathRouted())).toBe("app_mismatch");
    expect(reason(request("GET", { "x-pyre-app": "app_evil" }), pathRouted())).toBe("app_mismatch");
    expect(reason(request("GET", { "x-pyre-app": "app_evil" }), hostRouted())).toBe("app_mismatch");
  });

  it("still lets an uncredentialed server-to-server call through (no cookie, nothing to replay)", () => {
    expect(reason(request("POST"), pathRouted({ credentialed: false }))).toBeNull();
    expect(reason(request("POST", { origin: "https://api.pyre.test" }), pathRouted({ credentialed: false }))).toBeNull();
  });
});

describe("enforceSameOrigin on a host-routed app", () => {
  it("accepts its own origin and rejects other origins or a missing origin with a cookie", () => {
    expect(reason(request("POST", { origin: "https://victim.apps.pyre.test" }), hostRouted())).toBeNull();
    expect(reason(request("POST", { origin: "https://evil.apps.pyre.test" }), hostRouted())).toBe("origin_mismatch");
    expect(reason(request("POST"), hostRouted())).toBe("origin_missing");
  });
});

describe("app page headers", () => {
  it("send the page URL on same-origin requests only, so the referer path check has something to check", () => {
    const headers: Record<string, string> = {};
    applySecurityHeaders({ setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as Response);
    expect(headers["Referrer-Policy"]).toBe("same-origin");
  });
});
