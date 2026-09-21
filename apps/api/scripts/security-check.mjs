#!/usr/bin/env node
/**
 * Perimeter check for a deployed Pyre api. Exercises the security controls from the outside and
 * prints a pass/fail table.
 *
 *   node apps/api/scripts/security-check.mjs [apiOrigin]
 *
 * Env:
 *   PYRE_API_ORIGIN    api origin (default: the Railway production api)
 *   PYRE_APP_PATH      path-routed app to probe (default: /a/demo)
 *   PYRE_APP_ORIGIN    host-routed app origin; overrides PYRE_APP_PATH when set
 *   PYRE_GITHUB_SECRET GitHub webhook secret — enables the HMAC-accepted check
 *   PYRE_PROXY_TOKEN   a live JobToken — enables the model-allowlist check
 *   PYRE_INTERNAL_SECRET  enables the "/metrics answers with the bearer" check
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

const API = (process.argv[2] ?? process.env.PYRE_API_ORIGIN ?? "https://api.pyre.fun").replace(/\/+$/, "");
const APP_PATH = process.env.PYRE_APP_PATH ?? "/a/demo";
const APP_ORIGIN = process.env.PYRE_APP_ORIGIN ?? API;
/** Where the app lives: `<APP_ORIGIN><APP_BASE>/_pyre/...`. */
const APP_BASE = process.env.PYRE_APP_ORIGIN ? "" : APP_PATH;
const FOREIGN_ORIGIN = "https://evil.example";

const results = [];
const record = (name, status, detail) => results.push({ name, status, detail });

async function call(url, init = {}) {
  const started = Date.now();
  const res = await fetch(url, { redirect: "manual", ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json, ms: Date.now() - started };
}

const check = async (name, fn) => {
  try {
    const outcome = await fn();
    record(name, outcome.ok ? "PASS" : outcome.skip ? "SKIP" : "FAIL", outcome.detail);
  } catch (err) {
    record(name, "FAIL", `threw: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/* ───────────────── authentication ───────────────── */

const AUTHED_ROUTES = [
  ["GET", "/v1/me"],
  ["GET", "/v1/admin/ops"],
  ["GET", "/v1/admin/audit?limit=1"],
  ["GET", "/v1/admin/jobs"],
  ["POST", "/v1/launches"],
  ["POST", "/v1/pyre/stake"],
];

async function authChecks() {
  for (const [method, path] of AUTHED_ROUTES) {
    await check(`auth   ${method} ${path}`, async () => {
      const res = await call(`${API}${path}`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : {},
        body: method === "POST" ? "{}" : undefined,
      });
      return {
        ok: res.status === 401 || res.status === 403,
        detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}`,
      };
    });
  }
  await check("auth   forged bearer rejected", async () => {
    const res = await call(`${API}/v1/me`, { headers: { authorization: "Bearer not-a-real-session-token" } });
    return { ok: res.status === 401, detail: `${res.status} ${res.json?.error ?? ""}` };
  });
}

/* ───────────────── CSRF / origin ───────────────── */

const pyreUrl = (suffix) => `${APP_ORIGIN}${APP_BASE}/_pyre/${suffix}`;

async function originChecks() {
  await check("csrf   cross-origin POST /_pyre/kv", async () => {
    const res = await call(pyreUrl("kv/security-probe"), {
      method: "PUT",
      headers: { "content-type": "application/json", origin: FOREIGN_ORIGIN },
      body: JSON.stringify({ value: "probe" }),
    });
    return { ok: res.status === 403, detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}` };
  });

  await check("csrf   cross-origin POST /_pyre/checkout", async () => {
    const res = await call(pyreUrl("checkout"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: FOREIGN_ORIGIN },
      body: JSON.stringify({ productId: "probe" }),
    });
    return { ok: res.status === 403, detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}` };
  });

  await check("csrf   Sec-Fetch-Site: cross-site POST /_pyre/track", async () => {
    const res = await call(pyreUrl("track"), {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: "{}",
    });
    return { ok: res.status === 403, detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}` };
  });

  await check("csrf   cross-origin Referer POST /_pyre/fn", async () => {
    const res = await call(pyreUrl("fn/security-probe"), {
      method: "POST",
      headers: { "content-type": "application/json", referer: `${FOREIGN_ORIGIN}/attack.html` },
      body: "{}",
    });
    return { ok: res.status === 403, detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}` };
  });

  await check("csrf   same-origin POST /_pyre/track allowed", async () => {
    const res = await call(pyreUrl("track"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP_ORIGIN,
        referer: `${APP_ORIGIN}${APP_BASE}/`,
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    return { ok: res.status === 200, detail: `${res.status} ${res.text.slice(0, 40)}` };
  });
}

/* ───────────────── headers & cookies ───────────────── */

async function headerChecks() {
  await check("hdrs   CSP on app origin", async () => {
    const res = await call(`${APP_ORIGIN}${APP_BASE}/`);
    const csp = res.headers.get("content-security-policy");
    const missing = [
      csp ? null : "content-security-policy",
      res.headers.get("x-frame-options") ? null : "x-frame-options",
      res.headers.get("x-content-type-options") ? null : "x-content-type-options",
      res.headers.get("referrer-policy") ? null : "referrer-policy",
    ].filter(Boolean);
    return {
      ok: missing.length === 0 && (csp ?? "").includes("script-src 'self'"),
      detail: missing.length ? `missing ${missing.join(", ")}` : `script-src 'self' present (${res.status})`,
    };
  });

  await check("hdrs   app cookie flags", async () => {
    const res = await call(pyreUrl("track"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN, "sec-fetch-site": "same-origin" },
      body: "{}",
    });
    const cookie = res.headers.get("set-cookie");
    if (!cookie) return { ok: false, detail: `no Set-Cookie (status ${res.status})` };
    const lower = cookie.toLowerCase();
    const flags = ["httponly", "secure", "samesite", `path=${(APP_BASE || "/").toLowerCase()}`];
    const missing = flags.filter((f) => !lower.includes(f));
    return { ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(", ")}` : cookie.slice(0, 80) };
  });

  await check("hdrs   platform CORS rejects foreign origin", async () => {
    const res = await call(`${API}/v1/stats`, { headers: { origin: FOREIGN_ORIGIN } });
    const allow = res.headers.get("access-control-allow-origin");
    return { ok: allow !== FOREIGN_ORIGIN && allow !== "*", detail: `access-control-allow-origin: ${allow ?? "(none)"}` };
  });

  await check("hdrs   /metrics not public", async () => {
    const res = await call(`${API}/metrics`);
    const gated = res.status === 401 || res.status === 403 || res.status === 404;
    return { ok: gated, detail: `${res.status} ${res.text.slice(0, 60).replace(/\s+/g, " ")}` };
  });

  if (process.env.PYRE_INTERNAL_SECRET) {
    await check("hdrs   /metrics answers with bearer", async () => {
      const res = await call(`${API}/metrics`, {
        headers: { authorization: `Bearer ${process.env.PYRE_INTERNAL_SECRET}` },
      });
      return { ok: res.status === 200 || res.status === 404, detail: `${res.status} ${res.text.length} bytes` };
    });
  }
}

/* ───────────────── webhooks ───────────────── */

async function webhookChecks() {
  await check("hook   github without signature", async () => {
    const res = await call(`${API}/v1/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body: "{}",
    });
    return { ok: res.status === 401 || res.status === 503, detail: `${res.status} ${res.json?.error ?? ""}` };
  });

  await check("hook   github with wrong signature", async () => {
    const body = JSON.stringify({ action: "opened" });
    const res = await call(`${API}/v1/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
      body,
    });
    return { ok: res.status === 401 || res.status === 503, detail: `${res.status} ${res.json?.error ?? ""}` };
  });

  await check("rpc    write/sign methods refused, batches refused", async () => {
    const headers = { "content-type": "application/json" };
    const send = await call(`${API}/v1/rpc`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x00"] }) });
    const sign = await call(`${API}/v1/rpc`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "personal_sign", params: [] }) });
    const batch = await call(`${API}/v1/rpc`, { method: "POST", headers, body: JSON.stringify([{ jsonrpc: "2.0", id: 3, method: "eth_blockNumber", params: [] }]) });
    const logs = await call(`${API}/v1/rpc`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest" }] }) });
    return {
      ok: send.status === 403 && sign.status === 403 && batch.status === 400 && logs.status === 400,
      detail: `send ${send.status} / sign ${sign.status} / batch ${batch.status} / unbounded logs ${logs.status}`,
    };
  });

  await check("wallet forged signature rejected, bad address rejected", async () => {
    const headers = { "content-type": "application/json" };
    const address = "0x84F8E5a324466Deb7447048C014CF0245ce04afA";
    const challenge = await call(`${API}/v1/auth/wallet/challenge`, { method: "POST", headers, body: JSON.stringify({ address }) });
    const forged = await call(`${API}/v1/auth/wallet/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ address, signature: `0x${randomBytes(65).toString("hex")}` }),
    });
    const badAddress = await call(`${API}/v1/auth/wallet/challenge`, { method: "POST", headers, body: JSON.stringify({ address: "not-an-address" }) });
    return {
      ok: challenge.status === 200 && typeof challenge.json?.message === "string" && forged.status === 401 && badAddress.status === 400,
      detail: `challenge ${challenge.status} / forged ${forged.status} ${forged.json?.error ?? ""} / bad address ${badAddress.status}`,
    };
  });

  // Last of the auth-bucket probes: it exhausts this client's `auth` budget for the next minute.
  await check("auth   wallet challenge floods hit the auth rate limit", async () => {
    const headers = { "content-type": "application/json" };
    const address = `0x${randomBytes(20).toString("hex")}`;
    let limited = null;
    for (let i = 0; i < 40 && limited === null; i++) {
      const res = await call(`${API}/v1/auth/wallet/challenge`, { method: "POST", headers, body: JSON.stringify({ address }) });
      if (res.status === 429) limited = { after: i + 1, retryAfter: res.headers.get("retry-after") };
      else if (res.status !== 200 && res.status !== 400) return { ok: false, detail: `unexpected ${res.status} on request ${i + 1}` };
    }
    return { ok: limited !== null, detail: limited ? `429 after ${limited.after} requests (Retry-After ${limited.retryAfter})` : "no 429 within 40 requests" };
  });

  const githubSecret = process.env.PYRE_GITHUB_SECRET;
  await check("hook   github valid HMAC accepted + replayed", async () => {
    if (!githubSecret) return { ok: false, skip: true, detail: "PYRE_GITHUB_SECRET not set" };
    // Unknown repository: the handler answers `ignored` without touching any app.
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: `pyre-security-check/${randomBytes(4).toString("hex")}` },
      pull_request: {
        number: 1,
        title: "security check",
        html_url: "https://github.com/pyre-security-check/none/pull/1",
        user: { login: "security-check" },
        head: { sha: randomBytes(20).toString("hex") },
      },
    });
    const res = await call(`${API}/v1/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": randomBytes(16).toString("hex"),
        "x-hub-signature-256": `sha256=${createHmac("sha256", githubSecret).update(body).digest("hex")}`,
      },
      body,
    });
    return { ok: res.status === 200 && res.json?.ignored === true, detail: `${res.status} ${res.text.slice(0, 50)}` };
  });
}

/* ───────────────── Anthropic proxy ───────────────── */

const PROXY = `${API}/v1/proxy/anthropic`;

async function proxyChecks() {
  await check("proxy  no token", async () => {
    const res = await call(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    return { ok: res.status === 401, detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}` };
  });

  await check("proxy  bogus token", async () => {
    const res = await call(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": `sk-ant-${randomBytes(24).toString("hex")}` },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    return { ok: res.status === 401, detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}` };
  });

  await check("proxy  unknown path", async () => {
    const res = await call(`${PROXY}/v1/models`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": `sk-ant-${randomBytes(12).toString("hex")}` },
      body: "{}",
    });
    return { ok: res.status === 404, detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}` };
  });

  await check("proxy  oversized body", async () => {
    // 12 MB of padding: above the 8 MB parser/route ceiling.
    const body = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, pad: "x".repeat(12 * 1024 * 1024) });
    const res = await call(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": `sk-ant-${randomBytes(12).toString("hex")}` },
      body,
    });
    return { ok: res.status === 413, detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}` };
  });

  const proxyToken = process.env.PYRE_PROXY_TOKEN;
  await check("proxy  disallowed model", async () => {
    if (!proxyToken) return { ok: false, skip: true, detail: "PYRE_PROXY_TOKEN not set" };
    const res = await call(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxyToken },
      body: JSON.stringify({
        model: "claude-3-opus-20240229",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    return {
      ok: res.status === 403 && res.json?.error === "model_not_allowed",
      detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}`,
    };
  });

  await check("proxy  client auth headers stripped", async () => {
    // A caller-supplied `authorization`/`anthropic-beta` must never reach upstream; with an invalid
    // job token the request must still stop at our 401 rather than being forwarded.
    const res = await call(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer sk-ant-${randomBytes(12).toString("hex")}`,
        "anthropic-beta": "output-128k-2025-02-19",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    return { ok: res.status === 401, detail: `${res.status} ${res.json?.error ?? res.text.slice(0, 40)}` };
  });
}

/* ───────────────── rate limiting (runs last: it consumes a bucket) ───────────────── */

async function rateLimitChecks() {
  await check("rate   write class trips 429", async () => {
    // Anonymous POSTs: the limiter runs before auth and an unverifiable bearer mints no identity,
    // so this burst is charged to the client IP alone — the bucket the api resolves from Railway's
    // rewritten X-Forwarded-For. Each attempt costs nothing but a 401.
    const attempts = 45;
    let last = 0;
    const remaining = [];
    for (let i = 0; i < attempts; i++) {
      const res = await call(`${API}/v1/queue/security-check-probe/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      last = res.status;
      remaining.push(res.headers.get("ratelimit") ?? "");
      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const policy = res.headers.get("ratelimit-policy");
        return {
          ok: Boolean(retryAfter) && res.json?.error === "rate_limited",
          detail: `429 after ${i + 1} requests, Retry-After: ${retryAfter ?? "(missing)"}, policy: ${policy ?? "(missing)"}`,
        };
      }
    }
    return { ok: false, detail: `no 429 in ${attempts} requests (last ${last}; RateLimit: ${remaining[remaining.length - 1] || "(absent)"})` };
  });

  await check("rate   app function class trips 429", async () => {
    // Take a signed visitor cookie first: the app host keys anonymous callers on it before falling
    // back to the IP, so the bucket stays stable for the whole burst.
    const seed = await call(pyreUrl("track"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN, "sec-fetch-site": "same-origin" },
      body: "{}",
    });
    const visitor = (seed.headers.get("set-cookie") ?? "").split(";")[0];
    const headers = {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(visitor ? { cookie: visitor } : {}),
    };
    const attempts = 70;
    let lastLimit = "";
    for (let i = 0; i < attempts; i++) {
      const res = await call(pyreUrl("fn/security-check-probe"), { method: "POST", headers, body: "{}" });
      lastLimit = res.headers.get("ratelimit") ?? "";
      if (res.status === 429) {
        return {
          ok: Boolean(res.headers.get("retry-after")),
          detail: `429 after ${i + 1} calls, Retry-After: ${res.headers.get("retry-after") ?? "(missing)"}`,
        };
      }
    }
    return { ok: false, detail: `no 429 in ${attempts} calls (RateLimit: ${lastLimit || "(absent)"}, visitor cookie: ${visitor ? "yes" : "no"})` };
  });
}

/* ───────────────── report ───────────────── */

function print() {
  const width = results.reduce((max, r) => Math.max(max, r.name.length), 0);
  const line = `${"─".repeat(width + 2)}┼────────┼${"─".repeat(60)}`;
  console.log(`\nPyre perimeter check — ${API}  (app: ${APP_ORIGIN}${APP_BASE})\n`);
  console.log(`${"check".padEnd(width + 2)}│ result │ detail`);
  console.log(line);
  for (const r of results) {
    console.log(`${r.name.padEnd(width + 2)}│ ${r.status.padEnd(6)} │ ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log(
    `\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped` +
      `  ·  fingerprint ${createHash("sha256").update(results.map((r) => `${r.name}${r.status}`).join("|")).digest("hex").slice(0, 12)}\n`,
  );
  process.exitCode = failed > 0 ? 1 : 0;
}

await authChecks();
await originChecks();
await headerChecks();
await webhookChecks();
await proxyChecks();
await rateLimitChecks();
print();
