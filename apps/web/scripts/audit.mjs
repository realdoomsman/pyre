#!/usr/bin/env node
/*
 * Pyre web audit — performance, payload and accessibility, measured rather than
 * asserted.
 *
 * What it does:
 *   1. builds `apps/web` into a throwaway directory (so it never races a dev
 *      build in `dist/`),
 *   2. serves it with the real `server.mjs`, so the headers under test are the
 *      headers we ship,
 *   3. drives a spawned headless Chromium over raw CDP — no puppeteer, no
 *      lighthouse, no axe, no new dependencies,
 *   4. reports per-route transfer, Lighthouse-curve performance and
 *      accessibility scores, console errors, failed requests and a11y
 *      violations,
 *   5. exits non-zero when a budget is blown, so CI can own the regression.
 *
 * Scores are computed here, not by Lighthouse. Performance uses Lighthouse v10's
 * log-normal curves and weights for FCP, LCP, TBT and CLS, renormalised over
 * those four (Speed Index needs filmstrip capture we do not do) — so treat it as
 * "Lighthouse-style", comparable run to run rather than identical to a LH report.
 * Accessibility is a hand-rolled subset of axe rules; its score is the share of
 * applicable checks that pass, and every failure is printed with its selector.
 *
 * Usage:
 *   node scripts/audit.mjs
 *   node scripts/audit.mjs --no-build --dist=dist      # audit an existing build
 *   node scripts/audit.mjs --json                      # machine-readable
 *   node scripts/audit.mjs --mobile                    # 390px viewport pass
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * Budgets. Numbers are transferred kB (brotli/gzip on the wire, headers
 * included) of same-origin JS for a cold load of that route, set ~12% above what
 * this build actually does — tight enough to catch a regression like "someone
 * imported the sign-in stack (viem / GIS) into the entry graph", loose enough to
 * absorb a real feature. `forbid` names chunks that must not appear at all.
 *
 * `--seed-slug=<slug>` names a coin that exists on the API under test; the
 * default is the first item of `GET /v1/apps?sort=new`, resolved at start.
 */
const WALLET_CHUNKS = /\/assets\/wallet-[^/]*\.js$/;
const ROUTES = [
  {
    path: "/",
    label: "home",
    jsBudgetKb: 190,
    cssBudgetKb: 30,
    perfMin: 90,
    a11yMin: 95,
    // The whole point of the split: a visitor reading the feed must not pay for the sign-in stack.
    forbid: WALLET_CHUNKS,
    signInProbe: true,
  },
  { path: "/launch", label: "launch", jsBudgetKb: 260, cssBudgetKb: 30, perfMin: 90, a11yMin: 95, forbid: WALLET_CHUNKS, signInProbe: true },
  { path: "/apps", label: "apps", jsBudgetKb: 220, cssBudgetKb: 30, perfMin: 90, a11yMin: 95, forbid: WALLET_CHUNKS },
  { path: "/burns", label: "burns", jsBudgetKb: 220, cssBudgetKb: 30, perfMin: 90, a11yMin: 95, forbid: WALLET_CHUNKS },
  { path: "/pyre", label: "pyre", jsBudgetKb: 320, cssBudgetKb: 30, perfMin: 88, a11yMin: 95, forbid: WALLET_CHUNKS },
  { path: "/c/{seed}", label: "coin", jsBudgetKb: 360, cssBudgetKb: 30, perfMin: 88, a11yMin: 95, forbid: WALLET_CHUNKS },
  { path: "/me", label: "me", jsBudgetKb: 220, cssBudgetKb: 30, perfMin: 90, a11yMin: 95, forbid: WALLET_CHUNKS },
  { path: "/legal/terms", label: "legal", jsBudgetKb: 200, cssBudgetKb: 30, perfMin: 92, a11yMin: 95, forbid: WALLET_CHUNKS },
  { path: "/card", label: "share-card", jsBudgetKb: 170, cssBudgetKb: 30, perfMin: 90, a11yMin: 95, forbid: WALLET_CHUNKS },
];

/*
 * Failures the audit environment causes rather than the build. Google Identity
 * Services authorises by registered origin, and the audit serves the build from
 * 127.0.0.1: GIS answers 403 for an unregistered origin and its own headers
 * refuse to be framed. These are reported as "expected" and never fail the run.
 * Nothing else is forgiven — including anything else from those hosts.
 */
const EXPECTED_AUDIT_NOISE = [
  /accounts\.google\.com.*(gsi|g\/id)/,
  /Framing 'https:\/\/accounts\.google\.com/,
];

/**
 * Ceiling for any single emitted chunk, raw. The floor is the sign-in stack —
 * viem plus Google Identity Services — bundled into one deferred chunk;
 * `vite.config.ts` enforces the same number.
 */
const MAX_CHUNK_KB = 1200;

const DEFAULTS = {
  VITE_API_ORIGIN: "https://api.pyre.fun",
  VITE_GOOGLE_CLIENT_ID: "audit.apps.googleusercontent.com",
  VITE_APP_DOMAIN: "",
  VITE_PYRE_TOKEN: "",
  VITE_CHAIN_ID: "4663",
  VITE_EXPLORER_URL: "https://robinhoodchain.blockscout.com",
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OPTIONS = {
  build: !flag("no-build"),
  // Scratch lives in the OS temp dir, never in the working tree: a build (or a
  // live Chrome profile) inside the repo locks files and breaks `git add -A`.
  dist: opt("dist", join(tmpdir(), "pyre-webquality", "dist")),
  json: flag("json"),
  mobile: flag("mobile"),
  keepOpen: flag("keep-open"),
  seedSlug: opt("seed-slug", ""),
};

/** Resolves `{seed}` in route paths: `--seed-slug` or the newest coin the API lists. */
const resolveRoutes = async (apiOrigin) => {
  let seed = OPTIONS.seedSlug;
  if (!seed) {
    try {
      const res = await fetch(`${apiOrigin}/v1/apps?sort=new&limit=1`, { headers: { accept: "application/json" } });
      const page = res.ok ? await res.json() : null;
      seed = page?.items?.[0]?.slug ?? "";
    } catch {
      seed = "";
    }
  }
  return ROUTES.flatMap((r) => {
    if (!r.path.includes("{seed}")) return [r];
    if (!seed) {
      process.stderr.write("[audit] no coin to seed /c/:slug with — pass --seed-slug=<slug>; skipping the coin route\n");
      return [];
    }
    return [{ ...r, path: r.path.replace("{seed}", seed) }];
  });
};
const VIEWPORT = OPTIONS.mobile ? { width: 390, height: 844, mobile: true } : { width: 1440, height: 900, mobile: false };

// ─────────────────────────────────────────────────────────────── process helpers

const run = (cmd, args, env) =>
  new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: WEB_ROOT, shell: process.platform === "win32", stdio: "inherit", env });
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`))));
    child.on("error", fail);
  });

const freePort = () =>
  new Promise((ok) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });

const waitFor = async (check, { timeout = 20_000, every = 150, what = "condition" } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROMIUM_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const findChrome = () => {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!hit) throw new Error(`no Chrome/Chromium found — set CHROME_PATH (tried ${CHROME_CANDIDATES.length} paths)`);
  return hit;
};

// ─────────────────────────────────────────────────────────────── minimal CDP

class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();
  #handlers = new Map();

  static async connect(url) {
    const client = new Cdp();
    await client.#open(url);
    return client;
  }

  #open(url) {
    return new Promise((ok, fail) => {
      this.#ws = new WebSocket(url);
      this.#ws.addEventListener("open", () => ok());
      this.#ws.addEventListener("error", () => fail(new Error(`cdp connect failed: ${url}`)));
      this.#ws.addEventListener("message", (e) => this.#receive(JSON.parse(e.data)));
    });
  }

  #receive(msg) {
    if (msg.id) {
      const slot = this.#pending.get(msg.id);
      if (!slot) return;
      this.#pending.delete(msg.id);
      if (msg.error) slot.fail(new Error(`${slot.method}: ${msg.error.message}`));
      else slot.ok(msg.result);
      return;
    }
    for (const key of [msg.method, `${msg.sessionId ?? ""}:${msg.method}`]) {
      for (const cb of this.#handlers.get(key) ?? []) cb(msg.params, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((ok, fail) => this.#pending.set(id, { ok, fail, method }));
  }

  on(method, cb, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this.#handlers.has(key)) this.#handlers.set(key, []);
    this.#handlers.get(key).push(cb);
  }

  off(sessionId) {
    for (const key of [...this.#handlers.keys()]) if (key.startsWith(`${sessionId}:`)) this.#handlers.delete(key);
  }

  close() {
    this.#ws.close();
  }
}

// ─────────────────────────────────────────────────────────────── scoring

/** Complementary error function, Numerical Recipes rational approximation (|err| < 1.2e-7). */
const erfc = (x) => {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const y = t - 0.5;
  const poly =
    -1.26551223 +
    y * (1.00002368 + y * (0.37409196 + y * (0.09678418 + y * (-0.18628806 + y * (0.27886807 + y * (-1.13520398 + y * (1.48851587 + y * (-0.82215223 + y * 0.17087277))))))));
  const value = t * Math.exp(-z * z + poly);
  return x >= 0 ? value : 2 - value;
};

/** Lighthouse's log-normal metric scoring: value === p10 → 0.9, value === median → 0.5. */
const logNormalScore = ({ p10, median }, value) => {
  if (value <= 0) return 1;
  const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;
  const shape = (Math.log(median) - Math.log(p10)) / (INVERSE_ERFC_ONE_FIFTH * Math.SQRT2);
  return Math.min(1, Math.max(0, erfc((Math.log(value) - Math.log(median)) / (Math.SQRT2 * shape)) / 2));
};

/** Lighthouse v10 desktop curves + weights, minus Speed Index (renormalised). */
const PERF_METRICS = [
  { key: "fcp", label: "FCP", weight: 0.1, curve: { p10: 934, median: 1600 }, unit: "ms" },
  { key: "lcp", label: "LCP", weight: 0.25, curve: { p10: 1200, median: 2400 }, unit: "ms" },
  { key: "tbt", label: "TBT", weight: 0.3, curve: { p10: 150, median: 350 }, unit: "ms" },
  { key: "cls", label: "CLS", weight: 0.25, curve: { p10: 0.1, median: 0.25 }, unit: "" },
];

const perfScore = (metrics) => {
  let total = 0;
  let weight = 0;
  const parts = {};
  for (const m of PERF_METRICS) {
    const value = metrics[m.key];
    if (value === null || value === undefined) continue;
    const score = logNormalScore(m.curve, value);
    parts[m.key] = { value, score: Math.round(score * 100) };
    total += score * m.weight;
    weight += m.weight;
  }
  return { score: weight ? Math.round((total / weight) * 100) : null, parts };
};

// ─────────────────────────────────────────────────────────────── in-page probes

const PERF_PROBE = `
window.__pyre = { fcp: null, lcp: null, cls: 0, tbt: 0, longTasks: 0 };
try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__pyre.fcp = e.startTime;
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((l) => {
    const es = l.getEntries();
    if (es.length) window.__pyre.lcp = es[es.length - 1].startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput) window.__pyre.cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) { window.__pyre.longTasks++; window.__pyre.tbt += Math.max(0, e.duration - 50); }
  }).observe({ type: "longtask", buffered: true });
} catch (e) { window.__pyre.error = String(e); }
`;

/*
 * Hand-rolled accessibility checks. Deliberately the ones that break real users
 * and that a design pass can regress: names on controls, labels on inputs,
 * heading order, landmarks, contrast on the text/background pairs we actually
 * render, and a visible focus ring.
 */
const A11Y_PROBE = `(() => {
  const out = [];
  const seen = new Set();
  const sel = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + "#" + n.id); break; }
      const cls = (n.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const fail = (rule, el, detail) => {
    const key = rule + "|" + (el ? sel(el) : "") + "|" + (detail || "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rule, target: el ? sel(el) : "document", detail: detail || "" });
  };
  const name = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const ref = el.getAttribute("aria-labelledby");
    if (ref) {
      const text = ref.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (text) return text;
    }
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    const text = (el.innerText || el.textContent || "").trim();
    if (text) return text;
    const img = el.querySelector("img[alt]");
    if (img && img.getAttribute("alt").trim()) return img.getAttribute("alt").trim();
    return "";
  };

  const applicable = new Set();
  const mark = (rule) => applicable.add(rule);

  // 1. html lang + document title
  mark("html-has-lang");
  if (!document.documentElement.getAttribute("lang")) fail("html-has-lang", document.documentElement, "missing lang");
  mark("document-title");
  if (!document.title.trim()) fail("document-title", null, "empty <title>");

  // 2. images have alt (or are explicitly decorative)
  const imgs = [...document.querySelectorAll("img")].filter(visible);
  if (imgs.length) mark("image-alt");
  for (const img of imgs) {
    const decorative = img.getAttribute("aria-hidden") === "true" || img.getAttribute("role") === "presentation";
    if (!img.hasAttribute("alt") && !decorative) fail("image-alt", img, img.getAttribute("src") || "");
  }

  // 3. form fields have labels
  const fields = [...document.querySelectorAll("input, select, textarea")].filter(
    (el) => el.type !== "hidden" && visible(el),
  );
  if (fields.length) mark("form-label");
  for (const f of fields) {
    const labelled =
      (f.id && document.querySelector('label[for="' + CSS.escape(f.id) + '"]')) ||
      f.closest("label") ||
      (f.getAttribute("aria-label") || "").trim() ||
      (f.getAttribute("aria-labelledby") || "").trim() ||
      (f.getAttribute("title") || "").trim();
    if (!labelled) fail("form-label", f, f.getAttribute("placeholder") ? "placeholder only" : (f.type || f.tagName));
  }

  // 4. interactive controls have accessible names
  const controls = [...document.querySelectorAll("button, a[href], [role=button], [role=link], summary")].filter(visible);
  if (controls.length) mark("control-name");
  for (const c of controls) if (!name(c)) fail("control-name", c, "no accessible name");

  // 5. exactly one h1 and no skipped heading levels
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible);
  if (headings.length) {
    mark("heading-order");
    mark("single-h1");
    const h1s = headings.filter((h) => h.tagName === "H1");
    if (h1s.length !== 1) fail("single-h1", null, h1s.length + " <h1> elements");
    let prev = 0;
    for (const h of headings) {
      const level = Number(h.tagName[1]);
      if (prev && level > prev + 1) fail("heading-order", h, "h" + prev + " → h" + level);
      prev = level;
    }
  }

  // 6. landmarks. A main landmark is the one every document owes a screen-reader
  // user; a header/nav is layout-dependent (the share cards have none).
  mark("landmarks");
  if (!document.querySelector("main, [role=main]")) fail("landmarks", null, "no main landmark");

  // 7. contrast of rendered text against its effective background
  const parseColor = (v) => {
    const m = v.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[\\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  /*
   * Effective background, composited up the ancestor chain.
   *
   * A background-image is only indeterminate when there is no opaque colour
   * beneath it on the same element: .btn-primary is a bare gradient, so its
   * contrast cannot be computed and we report it as unmeasurable, the way axe
   * reports "incomplete". The body paints a faint grid and noise *over* an
   * opaque --color-bg, so that colour is the honest answer rather than a reason
   * to stop checking the entire page.
   */
  const bgOf = (el) => {
    let acc = null;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const c = parseColor(cs.backgroundColor);
      const hasImage = cs.backgroundImage !== "none";
      if (hasImage && (!c || c.a < 1)) return null;
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 1) return acc;
    }
    return acc || { r: 255, g: 255, b: 255, a: 1 };
  };
  const textEls = [...document.querySelectorAll("body *")].filter((el) => {
    if (!visible(el)) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  });
  if (textEls.length) mark("contrast");
  const worst = new Set();
  let contrastIncomplete = 0;
  for (const el of textEls.slice(0, 400)) {
    const cs = getComputedStyle(el);
    const fgRaw = parseColor(cs.color);
    if (!fgRaw) continue;
    const bg = bgOf(el);
    if (!bg) {
      contrastIncomplete++;
      continue;
    }
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const need = large ? 3 : 4.5;
    if (ratio + 0.01 < need) {
      const key = cs.color + "|" + Math.round(size) + "|" + [bg.r, bg.g, bg.b].map(Math.round).join(",");
      if (!worst.has(key)) {
        worst.add(key);
        fail(
          "contrast",
          el,
          ratio.toFixed(2) + ":1 (needs " + need + ") " + cs.color + " on rgb(" +
            [bg.r, bg.g, bg.b].map(Math.round).join(",") + ") at " + Math.round(size) + "px",
        );
      }
    }
  }

  // 8. focus is visible. Disabled controls cannot take focus at all, so they have nothing to show.
  const focusables = [...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")].filter(
    (el) => visible(el) && !el.matches(":disabled"),
  );
  if (focusables.length) mark("focus-visible");
  const active = document.activeElement;
  for (const el of focusables.slice(0, 30)) {
    const before = getComputedStyle(el);
    const baseline = [before.outlineWidth, before.outlineStyle, before.boxShadow, before.borderColor, before.backgroundColor].join("|");
    el.focus({ preventScroll: true });
    const after = getComputedStyle(el);
    const focused = [after.outlineWidth, after.outlineStyle, after.boxShadow, after.borderColor, after.backgroundColor].join("|");
    if (baseline === focused) fail("focus-visible", el, "no visible change on focus");
    el.blur();
  }
  if (active && active.focus) active.focus({ preventScroll: true });

  // 9. streaming regions announce themselves
  const live = document.querySelectorAll("[aria-live], [role=status], [role=alert], [role=log]").length;

  return JSON.stringify({
    violations: out,
    applicable: [...applicable],
    live,
    contrastIncomplete,
    counts: { imgs: imgs.length, fields: fields.length, controls: controls.length, headings: headings.length, text: textEls.length },
  });
})()`;

// ─────────────────────────────────────────────────────────────── route audit

const auditRoute = async (cdp, base, route) => {
  // No width/height: headless Chrome rejects a positioned target, and the
  // viewport comes from Emulation.setDeviceMetricsOverride below anyway.
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  const requests = new Map();
  const consoleErrors = [];
  const failed = [];
  /** 4xx/5xx from our own build — always a failure. */
  const badStatus = [];
  /** 4xx/5xx from the API, RPC or remote images: content, not build. Reported, never fatal. */
  const remoteStatus = [];
  const expected = [];
  let inflight = 0;
  let lastActivity = Date.now();
  let loaded = false;

  const on = (method, cb) => cdp.on(method, cb, sessionId);
  on("Network.requestWillBeSent", (p) => {
    requests.set(p.requestId, { url: p.request.url, type: p.type, bytes: 0, status: 0 });
    inflight++;
    lastActivity = Date.now();
  });
  on("Network.responseReceived", (p) => {
    const r = requests.get(p.requestId);
    if (!r) return;
    r.type = p.type;
    r.status = p.response.status;
    r.mime = p.response.mimeType;
    r.headers = p.response.headers;
    r.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker;
    if (p.response.status < 400) return;
    const line = `${p.response.status} ${r.url}`;
    if (EXPECTED_AUDIT_NOISE.some((re) => re.test(r.url))) expected.push(line);
    else if (r.url.startsWith(base)) badStatus.push(line);
    else remoteStatus.push(line);
  });
  on("Network.loadingFinished", (p) => {
    const r = requests.get(p.requestId);
    if (r) r.bytes = p.encodedDataLength;
    inflight = Math.max(0, inflight - 1);
    lastActivity = Date.now();
  });
  on("Network.loadingFailed", (p) => {
    const r = requests.get(p.requestId);
    inflight = Math.max(0, inflight - 1);
    lastActivity = Date.now();
    if (p.canceled) return;
    const line = `${r?.url ?? p.requestId}: ${p.errorText}`;
    if (EXPECTED_AUDIT_NOISE.some((re) => re.test(line))) expected.push(line);
    else failed.push(line);
  });
  on("Runtime.consoleAPICalled", (p) => {
    if (p.type !== "error") return;
    consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  });
  on("Runtime.exceptionThrown", (p) => {
    consoleErrors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
  });
  on("Log.entryAdded", (p) => {
    if (p.entry.level !== "error") return;
    // Network failures arrive with a URL through Network.* — this channel reports
    // them as "Failed to load resource" with no URL, which is just noise.
    if (p.entry.source === "network") return;
    const text = `[${p.entry.source}] ${p.entry.text}`;
    if (EXPECTED_AUDIT_NOISE.some((re) => re.test(text) || re.test(p.entry.url ?? ""))) expected.push(text);
    else consoleErrors.push(text);
  });
  on("Page.loadEventFired", () => {
    loaded = true;
    lastActivity = Date.now();
  });

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: VIEWPORT.mobile },
    sessionId,
  );
  // Lighthouse desktop preset: 10 Mbps, 40 ms RTT, no CPU throttling.
  await cdp.send(
    "Network.emulateNetworkConditions",
    { offline: false, latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (10 * 1024 * 1024) / 8 },
    sessionId,
  );
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PERF_PROBE }, sessionId);

  const started = Date.now();
  await cdp.send("Page.navigate", { url: base + route.path }, sessionId);
  await waitFor(async () => loaded, { timeout: 30_000, what: `load of ${route.path}` });
  // Quiet network for 900 ms, then a beat for lazy chunks to settle. The wait is
  // activity-based, not inflight-based: the live feed holds an SSE stream open
  // for the whole session and would otherwise never look idle.
  await waitFor(async () => Date.now() - lastActivity > 900, {
    timeout: 30_000,
    what: `network idle on ${route.path}`,
  });
  await new Promise((r) => setTimeout(r, 600));

  const evaluate = async (expression, awaitPromise = false) => {
    const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId);
    if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.text}`);
    return res.result.value;
  };

  /*
   * Snapshot here: everything requested up to this point is what a cold visit to
   * this route costs. The sign-in probe below deliberately downloads the wallet
   * stack, and that must not be counted against the route's budget.
   */
  const initialRequests = [...requests.values()];

  const perf = await evaluate("JSON.stringify(window.__pyre)");
  const a11y = JSON.parse(await evaluate(A11Y_PROBE));
  const title = await evaluate("document.title");
  const h1 = await evaluate('document.querySelector("h1")?.innerText?.slice(0,80) ?? ""');
  // Does clicking sign-in pull the wallet stack, and only then?
  let signIn = null;
  if (route.signInProbe) {
    const before = initialRequests.some((r) => WALLET_CHUNKS.test(new URL(r.url, base).pathname));
    const clicked = await evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /sign in|connect/i.test(b.innerText || ""));
      if (!btn) return "no sign-in control found";
      btn.click();
      return "clicked";
    })()`);
    if (clicked === "clicked") {
      await waitFor(
        async () => [...requests.values()].some((r) => WALLET_CHUNKS.test(new URL(r.url, base).pathname)),
        { timeout: 15_000, what: "wallet chunk after sign-in click" },
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
    const after = [...requests.values()].filter((r) => WALLET_CHUNKS.test(new URL(r.url, base).pathname));
    const modal = await evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
      const signInModal = dialogs.some((d) => /sign in with|sign in/i.test(d.innerText || ""));
      const gsi = !!document.querySelector("iframe[src*='accounts.google.com']");
      return signInModal || gsi;
    })()`);
    signIn = {
      control: clicked,
      walletBefore: before,
      walletAfter: after.length,
      walletKb: Math.round(after.reduce((s, r) => s + r.bytes, 0) / 1024),
      walletUi: modal,
    };
  }

  cdp.off(sessionId);
  await cdp.send("Target.closeTarget", { targetId });

  const all = initialRequests;
  const local = all.filter((r) => r.url.startsWith(base));
  const kindOf = (r) => {
    const path = new URL(r.url, base).pathname;
    if (/\.js$/.test(path)) return "js";
    if (/\.css$/.test(path)) return "css";
    if (/\.woff2?$/.test(path)) return "font";
    if (/\.(png|jpe?g|svg|webp|avif|gif|ico)$/.test(path)) return "img";
    if (r.type === "Document") return "html";
    return "other";
  };
  const bytes = { js: 0, css: 0, font: 0, img: 0, html: 0, other: 0 };
  for (const r of local) bytes[kindOf(r)] += r.bytes;
  const thirdParty = all.filter((r) => !r.url.startsWith(base));

  const metrics = JSON.parse(perf ?? "{}");
  const scored = perfScore(metrics);
  const applicable = a11y.applicable.length;
  const failedRules = new Set(a11y.violations.map((v) => v.rule));
  const a11yScore = applicable ? Math.round(((applicable - failedRules.size) / applicable) * 100) : null;

  return {
    route: route.path,
    label: route.label,
    title,
    h1,
    bytes,
    requests: { total: all.length, local: local.length, thirdParty: thirdParty.length },
    chunks: local.filter((r) => kindOf(r) === "js").map((r) => ({ url: new URL(r.url).pathname, kb: +(r.bytes / 1024).toFixed(1) })),
    forbidden: local
      .filter((r) => route.forbid && route.forbid.test(new URL(r.url).pathname))
      .map((r) => new URL(r.url).pathname),
    metrics,
    perf: scored,
    a11y: {
      score: a11yScore,
      applicable,
      violations: a11y.violations,
      live: a11y.live,
      incomplete: a11y.contrastIncomplete,
      counts: a11y.counts,
    },
    consoleErrors,
    failed,
    badStatus,
    remoteStatus,
    expected,
    signIn,
    wallMs: Date.now() - started,
  };
};

// ─────────────────────────────────────────────────────────────── header audit

const auditHeaders = async (base, distDir) => {
  const assets = readdirSync(join(distDir, "assets"));
  const js = assets.find((f) => /^index-.*\.js$/.test(f));
  const css = assets.find((f) => f.endsWith(".css"));
  const checks = [];
  const look = async (path, expectations) => {
    const res = await fetch(base + path, { redirect: "manual" });
    for (const [header, test, label] of expectations) {
      const value = res.headers.get(header);
      checks.push({ path, header: label ?? header, value, pass: test(value) });
    }
  };
  await look("/", [
    ["cache-control", (v) => /no-cache/.test(v ?? "")],
    ["content-security-policy", (v) => !!v && v.includes("default-src 'self'") && v.includes("accounts.google.com")],
    ["x-frame-options", (v) => v === "DENY"],
    ["referrer-policy", (v) => v === "strict-origin-when-cross-origin"],
    ["permissions-policy", (v) => !!v && v.includes("camera=()")],
    ["x-content-type-options", (v) => v === "nosniff"],
  ]);
  await look(`/assets/${js}`, [
    ["cache-control", (v) => /immutable/.test(v ?? "") && /max-age=31536000/.test(v ?? ""), "cache-control (entry js)"],
    ["content-encoding", (v) => v === "br" || v === "gzip", "content-encoding (entry js)"],
  ]);
  await look(`/assets/${css}`, [
    ["cache-control", (v) => /immutable/.test(v ?? ""), "cache-control (css)"],
  ]);
  await look("/favicon.svg", [
    ["cache-control", (v) => /must-revalidate/.test(v ?? ""), "cache-control (favicon)"],
  ]);
  return checks;
};

// ─────────────────────────────────────────────────────────────── bundle audit

const auditBundle = (distDir) => {
  const dir = join(distDir, "assets");
  const chunks = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ file: f, kb: +(statSync(join(dir, f)).size / 1024).toFixed(1) }))
    .sort((a, b) => b.kb - a.kb);
  return { chunks, oversized: chunks.filter((c) => c.kb > MAX_CHUNK_KB) };
};

// ─────────────────────────────────────────────────────────────── reporting

const pad = (s, n) => String(s).padEnd(n);
const padS = (s, n) => String(s).padStart(n);
const kb = (bytes) => (bytes / 1024).toFixed(1);

const report = (results, headers, bundle) => {
  const lines = [];
  const say = (s = "") => lines.push(s);

  say();
  say(`  Pyre web audit — ${VIEWPORT.width}×${VIEWPORT.height}${VIEWPORT.mobile ? " (mobile)" : ""}, cache disabled, 10 Mbps / 40 ms`);
  say(`  ${"─".repeat(104)}`);
  say(
    `  ${pad("route", 16)}${padS("js kB", 8)}${padS("css kB", 8)}${padS("font kB", 9)}${padS("total kB", 10)}${padS("perf", 6)}${padS("a11y", 6)}${padS("errors", 8)}${padS("FCP", 7)}${padS("LCP", 7)}${padS("TBT", 7)}${padS("CLS", 7)}`,
  );
  for (const r of results) {
    const total = Object.values(r.bytes).reduce((a, b) => a + b, 0);
    say(
      `  ${pad(r.label, 16)}${padS(kb(r.bytes.js), 8)}${padS(kb(r.bytes.css), 8)}${padS(kb(r.bytes.font), 9)}${padS(kb(total), 10)}` +
        `${padS(r.perf.score ?? "—", 6)}${padS(r.a11y.score ?? "—", 6)}${padS(r.consoleErrors.length + r.failed.length, 8)}` +
        `${padS(Math.round(r.metrics.fcp ?? 0), 7)}${padS(Math.round(r.metrics.lcp ?? 0), 7)}${padS(Math.round(r.metrics.tbt ?? 0), 7)}${padS((r.metrics.cls ?? 0).toFixed(3), 7)}`,
    );
  }
  say(`  ${"─".repeat(104)}`);

  for (const r of results) {
    say();
    say(`  ${r.route}  —  "${r.title}"   h1: ${r.h1 || "(none)"}`);
    say(`     js chunks (${r.chunks.length}): ${r.chunks.map((c) => `${c.url.replace("/assets/", "")} ${c.kb}kB`).join(", ")}`);
    say(`     requests: ${r.requests.local} same-origin, ${r.requests.thirdParty} third-party (API/RPC)`);
    if (r.forbidden.length) say(`     WALLET CHUNKS PRESENT: ${r.forbidden.join(", ")}`);
    else say(`     wallet stack: not loaded`);
    if (r.a11y.violations.length) {
      say(`     a11y violations (${r.a11y.violations.length}):`);
      for (const v of r.a11y.violations.slice(0, 14)) say(`       · ${pad(v.rule, 14)} ${v.target}  ${v.detail}`);
      if (r.a11y.violations.length > 14) say(`       · … ${r.a11y.violations.length - 14} more`);
    } else
      say(
        `     a11y: ${r.a11y.applicable} checks, 0 violations, ${r.a11y.incomplete} contrast pair(s) unmeasurable (gradient), ${r.a11y.live} live region(s)`,
      );
    for (const e of r.consoleErrors.slice(0, 8)) say(`     console error: ${e.slice(0, 200)}`);
    for (const f of r.failed.slice(0, 8)) say(`     failed request: ${f.slice(0, 200)}`);
    for (const s of r.badStatus.slice(0, 8)) say(`     http ${s.slice(0, 200)}  (our build)`);
    for (const s of r.remoteStatus.slice(0, 8)) say(`     http ${s.slice(0, 200)}  (remote content — reported, not fatal)`);
    if (r.expected.length) say(`     expected under audit origin (not counted): ${r.expected.length}`);
    if (r.signIn) {
      say(
        `     sign-in probe: ${r.signIn.control}; wallet chunk before click: ${r.signIn.walletBefore ? "YES" : "no"}; ` +
          `after: ${r.signIn.walletAfter} file(s) / ${r.signIn.walletKb} kB; sign-in UI in DOM: ${r.signIn.walletUi ? "yes" : "no"}`,
      );
    }
  }

  say();
  say(`  headers`);
  for (const c of headers) {
    say(`     ${c.pass ? "ok  " : "FAIL"} ${pad(c.path, 34)} ${pad(c.header, 30)} ${String(c.value).slice(0, 60)}`);
  }

  say();
  say(`  bundle — ${bundle.chunks.length} js chunks, largest:`);
  for (const c of bundle.chunks.slice(0, 6)) say(`     ${padS(c.kb, 9)} kB  ${c.file}`);
  say(`     limit ${MAX_CHUNK_KB} kB raw → ${bundle.oversized.length ? `OVER: ${bundle.oversized.map((c) => c.file).join(", ")}` : "ok"}`);

  return lines.join("\n");
};

const enforce = (results, headers, bundle) => {
  const problems = [];
  for (const r of results) {
    const spec = ROUTES.find((x) => x.label === r.label);
    const jsKb = r.bytes.js / 1024;
    if (jsKb > spec.jsBudgetKb) problems.push(`${r.route}: initial JS ${jsKb.toFixed(1)} kB > budget ${spec.jsBudgetKb} kB`);
    if (r.bytes.css / 1024 > spec.cssBudgetKb)
      problems.push(`${r.route}: CSS ${kb(r.bytes.css)} kB > budget ${spec.cssBudgetKb} kB`);
    if (r.forbidden.length) problems.push(`${r.route}: loaded wallet chunk(s) ${r.forbidden.join(", ")}`);
    if (r.consoleErrors.length) problems.push(`${r.route}: ${r.consoleErrors.length} console error(s)`);
    if (r.failed.length) problems.push(`${r.route}: ${r.failed.length} failed request(s)`);
    if (r.badStatus.length) problems.push(`${r.route}: ${r.badStatus.length} request(s) returned 4xx/5xx — ${r.badStatus[0]}`);
    if (r.perf.score !== null && r.perf.score < spec.perfMin)
      problems.push(`${r.route}: performance ${r.perf.score} < ${spec.perfMin}`);
    if (r.a11y.score !== null && r.a11y.score < spec.a11yMin)
      problems.push(`${r.route}: accessibility ${r.a11y.score} < ${spec.a11yMin} (${[...new Set(r.a11y.violations.map((v) => v.rule))].join(", ")})`);
    if (r.signIn && r.signIn.control !== "clicked") problems.push(`${r.route}: no sign-in control found`);
    if (r.signIn && r.signIn.control === "clicked" && r.signIn.walletAfter === 0)
      problems.push(`${r.route}: sign-in click did not load the wallet stack`);
  }
  for (const c of headers) if (!c.pass) problems.push(`header ${c.path} ${c.header}: ${c.value}`);
  for (const c of bundle.oversized) problems.push(`chunk ${c.file} is ${c.kb} kB > ${MAX_CHUNK_KB} kB`);
  return problems;
};

// ─────────────────────────────────────────────────────────────── main

const main = async () => {
  const distDir = resolve(WEB_ROOT, OPTIONS.dist);
  const env = { ...DEFAULTS, ...process.env };

  if (OPTIONS.build) {
    console.log(`[audit] building → ${OPTIONS.dist}`);
    await run("npx", ["vite", "build", "--outDir", OPTIONS.dist, "--emptyOutDir"], env);
  }
  if (!existsSync(join(distDir, "index.html"))) throw new Error(`${distDir}/index.html missing — drop --no-build`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(WEB_ROOT, "server.mjs")], {
    cwd: WEB_ROOT,
    env: { ...env, PORT: String(port), WEB_DIST: distDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[web] ${d}`));

  const chromeProfile = mkdtempSync(join(tmpdir(), "pyre-audit-"));
  const cdpPort = await freePort();
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeProfile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--hide-scrollbars",
      "--disable-gpu",
      /*
       * The audit serves the build from 127.0.0.1 while the app talks to the
       * deployed API, whose CORS allowlist is the real web origin. Without this
       * every data fetch fails and the run drowns in CORS noise that says nothing
       * about the build. Same-origin policy is the only thing relaxed; CSP is
       * still enforced, which is the header we are actually testing.
       */
      "--disable-web-security",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
    { stdio: "ignore" },
  );

  let cdp;
  const cleanup = async () => {
    try {
      cdp?.close();
    } catch {}
    chrome.kill();
    server.kill();
    try {
      rmSync(chromeProfile, { recursive: true, force: true });
    } catch {}
  };

  try {
    await waitFor(async () => fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false), { what: "web server" });
    let wsUrl = null;
    await waitFor(
      async () => {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).catch(() => null);
        if (!res?.ok) return false;
        wsUrl = (await res.json()).webSocketDebuggerUrl;
        return !!wsUrl;
      },
      { what: "chrome devtools endpoint", timeout: 30_000 },
    );
    cdp = await Cdp.connect(wsUrl);

    const results = [];
    const routes = await resolveRoutes(env.VITE_API_ORIGIN);
    for (const route of routes) {
      process.stderr.write(`[audit] ${route.path} …\n`);
      results.push(await auditRoute(cdp, base, route));
    }
    const headers = await auditHeaders(base, distDir);
    const bundle = auditBundle(distDir);
    const problems = enforce(results, headers, bundle);

    if (OPTIONS.json) {
      console.log(JSON.stringify({ viewport: VIEWPORT, results, headers, bundle, problems }, null, 2));
    } else {
      console.log(report(results, headers, bundle));
      console.log();
      if (problems.length) {
        console.log(`  ${problems.length} budget failure(s):`);
        for (const p of problems) console.log(`     ✗ ${p}`);
      } else {
        console.log("  all budgets met");
      }
      console.log();
    }
    await cleanup();
    process.exit(problems.length ? 1 : 0);
  } catch (err) {
    await cleanup();
    console.error(`[audit] ${err.stack ?? err}`);
    process.exit(2);
  }
};

await main();
