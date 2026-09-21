import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { rewriteHtml, toFilePath } from "../src/host/files.js";
import { applySecurityHeaders } from "../src/host/headers.js";
import { matchAppRequest } from "../src/host/resolve.js";

/**
 * Host routing. Every deployed app is reachable two ways — `<slug>.<APP_DOMAIN>/` and
 * `/a/<slug>/` — and both must produce the same asset URLs. `APP_DOMAIN` is `apps.pyre.test`
 * for this run (see vitest.config.ts).
 */

/** Only the two fields `matchAppRequest` reads; building a real express Request needs a server. */
const asRequest = (url: string, host?: string): Request =>
  ({ url, headers: host === undefined ? {} : { host } }) as unknown as Request;

describe("matchAppRequest", () => {
  it("resolves path-routed apps and strips the prefix", () => {
    expect(matchAppRequest(asRequest("/a/inboxzero"))).toEqual({ slug: "inboxzero", basePath: "/a/inboxzero", url: "/" });
    expect(matchAppRequest(asRequest("/a/inboxzero/"))).toEqual({ slug: "inboxzero", basePath: "/a/inboxzero", url: "/" });
    expect(matchAppRequest(asRequest("/a/inboxzero/assets/app.js"))).toEqual({
      slug: "inboxzero",
      basePath: "/a/inboxzero",
      url: "/assets/app.js",
    });
    expect(matchAppRequest(asRequest("/a/inboxzero/_pyre/fn/summarize"))).toEqual({
      slug: "inboxzero",
      basePath: "/a/inboxzero",
      url: "/_pyre/fn/summarize",
    });
  });

  it("keeps the query string with the relative url, not with the slug", () => {
    expect(matchAppRequest(asRequest("/a/demo?ref=x"))).toEqual({ slug: "demo", basePath: "/a/demo", url: "?ref=x" });
    expect(matchAppRequest(asRequest("/a/demo/?ref=x"))).toEqual({ slug: "demo", basePath: "/a/demo", url: "/?ref=x" });
    expect(matchAppRequest(asRequest("/a/demo/page?q=a/b"))).toEqual({ slug: "demo", basePath: "/a/demo", url: "/page?q=a/b" });
  });

  it("resolves host-routed apps with an empty base path", () => {
    expect(matchAppRequest(asRequest("/", "inboxzero.apps.pyre.test"))).toEqual({ slug: "inboxzero", basePath: "", url: "/" });
    expect(matchAppRequest(asRequest("/assets/app.js", "inboxzero.apps.pyre.test"))).toEqual({
      slug: "inboxzero",
      basePath: "",
      url: "/assets/app.js",
    });
    // Port and casing are normalized before the suffix check.
    expect(matchAppRequest(asRequest("/", "InboxZero.Apps.Pyre.Test:8080"))).toEqual({ slug: "inboxzero", basePath: "", url: "/" });
  });

  it("refuses hosts that are not app subdomains", () => {
    for (const host of [
      "apps.pyre.test", // the bare app domain is not an app
      "api.pyre.test",
      "ship.test",
      "inboxzero.apps.pyre.test.evil.com",
      "deep.nested.apps.pyre.test", // a slug may not contain a dot
      "bad_slug.apps.pyre.test",
      "",
    ]) {
      expect(matchAppRequest(asRequest("/", host))).toBeNull();
    }
    expect(matchAppRequest(asRequest("/"))).toBeNull();
  });

  it("reserves platform subdomains so api/www reach the platform API, not an app host", () => {
    // With APP_DOMAIN as the apex (e.g. pyre.fun), `api.<domain>` would otherwise resolve to app "api".
    for (const host of ["api.apps.pyre.test", "www.apps.pyre.test", "admin.apps.pyre.test"]) {
      expect(matchAppRequest(asRequest("/", host))).toBeNull();
      expect(matchAppRequest(asRequest("/v1/stats", host))).toBeNull();
    }
    // Same reservation on the path-routed form.
    expect(matchAppRequest(asRequest("/a/api"))).toBeNull();
    expect(matchAppRequest(asRequest("/a/www/assets/x.js"))).toBeNull();
  });

  it("refuses malformed path-routed slugs instead of matching a prefix", () => {
    for (const url of [
      "/a/",
      "/a//assets/app.js",
      "/a/UPPER",
      "/a/bad_slug",
      "/a/has.dot",
      `/a/${"x".repeat(41)}`,
      "/a/%2e%2e%2fadmin",
      "/apps/inboxzero",
      "/aa/inboxzero",
    ]) {
      expect(matchAppRequest(asRequest(url))).toBeNull();
    }
  });

  it("does not let a host-routed app hijack another app's /a/ prefix", () => {
    // Path match wins, so `/a/other` on inboxzero's host still resolves to `other`.
    expect(matchAppRequest(asRequest("/a/other/x", "inboxzero.apps.pyre.test"))).toEqual({
      slug: "other",
      basePath: "/a/other",
      url: "/x",
    });
  });
});

describe("rewriteHtml", () => {
  const html = [
    "<!doctype html><html><head>",
    '<link rel="stylesheet" href="./assets/index-abc.css">',
    '<script type="module" src="./assets/index-def.js"></script>',
    '<link rel="icon" href="/favicon.svg">',
    "</head><body>",
    '<img src="//cdn.pyre.fun/logo.png">',
    '<a href="https://ship.fun/docs">docs</a>',
    '<a href="mailto:hi@ship.fun">mail</a>',
    '<a href="#section">anchor</a>',
    "</body></html>",
  ].join("");

  it("anchors relative assets to the app root for path-routed apps", () => {
    const out = rewriteHtml(html, "/a/inboxzero");
    expect(out).toContain('href="/a/inboxzero/assets/index-abc.css"');
    expect(out).toContain('src="/a/inboxzero/assets/index-def.js"');
    expect(out).toContain('href="/a/inboxzero/favicon.svg"');
    expect(out).toContain('<script src="/a/inboxzero/_pyre/env.js"></script>');
  });

  it("produces root-absolute assets for host-routed apps", () => {
    const out = rewriteHtml(html, "");
    expect(out).toContain('href="/assets/index-abc.css"');
    expect(out).toContain('src="/assets/index-def.js"');
    expect(out).toContain('href="/favicon.svg"');
    expect(out).toContain('<script src="/_pyre/env.js"></script>');
  });

  it("prefixes every relative and root-absolute asset exactly once", () => {
    // Regression: this used to be two chained `.replace()` calls — the `/`-anchored pass re-prefixed
    // the URLs the `./` pass had just made absolute, yielding `/a/slug/a/slug/assets/...`.
    // A single Vite bundle contains both spellings, so one pass must handle both.
    const mixed = '<script src="./assets/a.js"></script><link href="/assets/b.css"><img src="./logo.png">';
    const out = rewriteHtml(mixed, "/a/inboxzero");
    expect(out).toContain('src="/a/inboxzero/assets/a.js"');
    expect(out).toContain('href="/a/inboxzero/assets/b.css"');
    expect(out).toContain('src="/a/inboxzero/logo.png"');
    expect(out).not.toContain("/a/inboxzero/a/inboxzero");
    expect(out.split("/a/inboxzero/").length - 1).toBe(4); // three assets + the injected env script
    // Host-routed mode must not turn "/assets" into the protocol-relative "//assets".
    const hostRouted = rewriteHtml(mixed, "");
    expect(hostRouted).toContain('src="/assets/a.js"');
    expect(hostRouted).toContain('href="/assets/b.css"');
    expect(hostRouted).not.toContain("//assets");
  });

  it("leaves external, protocol-relative, scheme and anchor URLs alone", () => {
    const out = rewriteHtml(html, "/a/inboxzero");
    expect(out).toContain('src="//cdn.pyre.fun/logo.png"');
    expect(out).toContain('href="https://ship.fun/docs"');
    expect(out).toContain('href="mailto:hi@ship.fun"');
    expect(out).toContain('href="#section"');
  });

  it("injects the env script exactly once, before </head>", () => {
    const out = rewriteHtml(html, "/a/demo");
    const tag = '<script src="/a/demo/_pyre/env.js"></script>';
    expect(out.split(tag).length - 1).toBe(1);
    expect(out.indexOf(tag)).toBeLessThan(out.search(/<\/head>/i));
  });

  it("still injects the env script when the document has no head", () => {
    const out = rewriteHtml("<div>bare fragment</div>", "/a/demo");
    expect(out).toBe('<script src="/a/demo/_pyre/env.js"></script><div>bare fragment</div>');
  });

  it("matches attributes case-insensitively but only on real attribute boundaries", () => {
    const out = rewriteHtml('<img SRC="./a.png"><x data-src="./b.png"><y href="./c.css">', "/a/demo");
    expect(out).toContain('SRC="/a/demo/a.png"');
    expect(out).toContain('href="/a/demo/c.css"');
    // `data-src` is not `src`; rewriting it would corrupt app-authored data attributes.
    expect(out).toContain('data-src="./b.png"');
  });
});

describe("toFilePath", () => {
  it("normalizes request paths to deployment file keys", () => {
    expect(toFilePath("/")).toBe("");
    expect(toFilePath("/index.html")).toBe("index.html");
    expect(toFilePath("/assets/app-1.js")).toBe("assets/app-1.js");
    expect(toFilePath("//assets//app.js")).toBe("assets/app.js");
    expect(toFilePath("/assets/my%20file.css")).toBe("assets/my file.css");
  });

  it("refuses traversal, backslashes, NUL bytes and bad encoding", () => {
    for (const path of [
      "/../secrets.env",
      "/assets/../../etc/passwd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/./app.js",
      "/assets\\app.js",
      "/assets/%5Cwin.js",
      "/assets/app%00.js",
      "/%E0%A4%A",
    ]) {
      expect(toFilePath(path)).toBeNull();
    }
  });
});

describe("applySecurityHeaders", () => {
  it("lets an app talk only to its own origin and Google sign-in — no wallet or RPC hosts", () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as Response;
    applySecurityHeaders(res);
    const csp: Record<string, string> = {};
    for (const directive of headers["Content-Security-Policy"]!.split(";")) {
      const [name, ...values] = directive.trim().split(/\s+/);
      csp[name!] = values.join(" ");
    }
    expect(csp["default-src"]).toBe("'self'");
    expect(csp["connect-src"]).toBe("'self' https://accounts.google.com/gsi/");
    expect(csp["script-src"]).toBe("'self' https://accounts.google.com/gsi/client");
    expect(csp["frame-src"]).toBe("https://accounts.google.com/gsi/");
    expect(csp["form-action"]).toBe("'none'");
    expect(csp["base-uri"]).toBe("'none'");
  });
});
