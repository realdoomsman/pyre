import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";

/**
 * Local stand-in for the platform endpoints an app talks to in production
 * (`/_pyre/*`). It exists so `npm run dev`, `npm run preview` and the Playwright
 * smoke test work on a laptop and inside the build sandbox, where there is no
 * Pyre host, no custodial wallet and no Robinhood Chain RPC.
 *
 * It implements exactly the endpoints that need no secrets:
 *   GET  /_pyre/env.js        runtime env, built from pyre.manifest.json
 *   GET  /_pyre/me            always an anonymous session
 *   POST /_pyre/track         accepted, discarded
 *   GET  /_pyre/ad            204 (no ad network locally)
 *   GET  /_pyre/kv/app/:key   app-scope storage written by functions/*.js
 *   POST /_pyre/fn/:name      runs functions/<name>.js in this Node process
 *
 * Everything that needs a real wallet, session or treasury answers 503 with an
 * explanatory message instead of pretending to work.
 */

const ROOT = process.cwd();
const ENV_TAG = '<script src="/_pyre/env.js"></script>';

/** Robinhood Chain facts. Payments cannot be made locally, but the addresses are public. */
const CHAIN_ID = 4663;
const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

interface ManifestFunction {
  name: string;
  priceUsd: number;
  auth: boolean;
  holderOnly: boolean;
}

interface ManifestProduct {
  id: string;
  name: string;
  priceUsd: number;
  kind: "ONE_TIME" | "SUBSCRIPTION_MONTHLY";
}

interface Manifest {
  name: string;
  functions: ManifestFunction[];
  products: ManifestProduct[];
  adSlot: boolean;
  minHoldTokens: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads `pyre.manifest.json` on every request so edits show up without a restart. */
async function loadManifest(): Promise<Manifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(ROOT, "pyre.manifest.json"), "utf8"));
  } catch (cause) {
    throw new Error(`pyre.manifest.json is missing or not valid JSON: ${String(cause)}`);
  }
  const m = record(parsed);
  const functions: ManifestFunction[] = (Array.isArray(m.functions) ? m.functions : []).map((raw) => {
    const f = record(raw);
    return {
      name: String(f.name ?? ""),
      priceUsd: typeof f.priceUsd === "number" ? f.priceUsd : 0,
      auth: f.auth === true,
      holderOnly: f.holderOnly === true,
    };
  });
  const products: ManifestProduct[] = (Array.isArray(m.products) ? m.products : []).map((raw) => {
    const p = record(raw);
    return {
      id: String(p.id ?? ""),
      name: String(p.name ?? ""),
      priceUsd: typeof p.priceUsd === "number" ? p.priceUsd : 0,
      kind: p.kind === "SUBSCRIPTION_MONTHLY" ? "SUBSCRIPTION_MONTHLY" : "ONE_TIME",
    };
  });
  const tier = record(m.holderTier);
  return {
    name: typeof m.name === "string" && m.name !== "" ? m.name : "Pyre App",
    functions,
    products,
    adSlot: m.adSlot === true,
    minHoldTokens: typeof tier.minHoldTokens === "number" ? tier.minHoldTokens : 0,
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

const KV_KEY = /^[A-Za-z0-9_.:-]{1,120}$/;

/** The `ship` object handed to `functions/<name>.js`, matching the sandbox host API. */
function functionApi(input: unknown, appKv: Map<string, unknown>): Record<string, unknown> {
  const checkKey = (key: string): string => {
    if (!KV_KEY.test(key)) throw new Error(`invalid kv key: ${key}`);
    return key;
  };
  return {
    input,
    // The platform always passes an object; `id` is null for anonymous callers.
    user: { id: null, wallet: null, isHolder: false },
    kv: {
      get: async (key: string) => (appKv.has(checkKey(key)) ? appKv.get(key) : null),
      set: async (key: string, value: unknown) => {
        if (JSON.stringify(value ?? null).length > 64 * 1024) throw new Error(`kv value for ${key} exceeds 64KB`);
        appKv.set(checkKey(key), value);
      },
      del: async (key: string) => {
        appKv.delete(checkKey(key));
      },
    },
    llm: async () => {
      throw new Error("ship.llm() needs the platform's model access — it only runs on Pyre");
    },
    fetch: async () => {
      throw new Error("ship.fetch() is restricted to other Pyre apps — it only runs on Pyre");
    },
  };
}

function pyreRoutes(appKv: Map<string, unknown>) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (!path.startsWith("/_pyre/")) {
      next();
      return;
    }
    try {
      if (path === "/_pyre/env.js") {
        const manifest = await loadManifest();
        const env = {
          appId: "local",
          slug: "local",
          name: manifest.name,
          ticker: "LOCAL",
          chainId: CHAIN_ID,
          usdg: USDG_ADDRESS,
          // Empty: no treasury, no coin and no Google project locally — the SDK runs without payments,
          // holder gating and sign-in.
          treasury: "",
          tokenAddress: "",
          explorerUrl: EXPLORER_URL,
          googleClientId: "",
          apiOrigin: "",
          basePath: "",
          holderMin: String(manifest.minHoldTokens),
          adSlot: manifest.adSlot,
          products: manifest.products,
          functions: manifest.functions,
        };
        res.statusCode = 200;
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(`window.__PYRE__ = ${JSON.stringify(env)};\n`);
        return;
      }

      if (path === "/_pyre/me") {
        const manifest = await loadManifest();
        sendJson(res, 200, {
          user: null,
          holder: { isHolder: false, balance: "0", minHold: String(manifest.minHoldTokens) },
          purchases: [],
        });
        return;
      }

      if (path === "/_pyre/track") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === "/_pyre/ad") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (path.startsWith("/_pyre/kv/app/")) {
        const key = decodeURIComponent(path.slice("/_pyre/kv/app/".length));
        if (req.method === "GET") {
          sendJson(res, 200, { value: appKv.has(key) ? appKv.get(key) : null });
          return;
        }
        sendJson(res, 405, { error: "the app namespace is written by functions/*.js, not the browser" });
        return;
      }

      if (path.startsWith("/_pyre/kv/")) {
        sendJson(res, 401, { error: "per-user storage needs a logged-in user; log in on the deployed app" });
        return;
      }

      if (path.startsWith("/_pyre/fn/")) {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "use POST" });
          return;
        }
        const name = decodeURIComponent(path.slice("/_pyre/fn/".length));
        if (!/^[a-z0-9_-]{1,40}$/.test(name)) {
          sendJson(res, 404, { error: `no such function: ${name}` });
          return;
        }
        const manifest = await loadManifest();
        const declared = manifest.functions.find((f) => f.name === name);
        if (!declared) {
          sendJson(res, 404, { error: `functions/${name}.js is not declared in pyre.manifest.json` });
          return;
        }
        if (declared.priceUsd > 0) {
          sendJson(res, 503, {
            error: `${name} costs $${declared.priceUsd} per call and can only be paid on the deployed app`,
          });
          return;
        }
        const input = await readBody(req);
        const file = resolve(ROOT, "functions", `${name}.js`);
        // Runtime-selected specifier: the function name comes from the request path.
        // Cache-busted so edits to the function are picked up without restarting vite.
        const mod: unknown = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
        const handler = record(mod).default;
        if (typeof handler !== "function") {
          sendJson(res, 500, { error: `functions/${name}.js must export default an async function` });
          return;
        }
        const result: unknown = await handler(input, functionApi(input, appKv));
        sendJson(res, 200, { result: result === undefined ? null : result });
        return;
      }

      if (path === "/_pyre/checkout" || path.startsWith("/_pyre/checkout/")) {
        sendJson(res, 503, { error: "payments need the Pyre host and a custodial wallet; they only work on the deployed app" });
        return;
      }

      if (path.startsWith("/_pyre/auth/")) {
        sendJson(res, 503, { error: "login needs the Pyre host; it only works on the deployed app" });
        return;
      }

      sendJson(res, 404, { error: `no local implementation of ${path}` });
    } catch (cause) {
      sendJson(res, 500, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  };
}

export function pyreLocalHost(): Plugin {
  const appKv = new Map<string, unknown>();
  const routes = pyreRoutes(appKv);

  return {
    name: "pyre-local-host",
    // Never part of `vite build`: production index.html must stay free of the env tag,
    // the real host injects its own.
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html.includes(ENV_TAG) ? html : html.replace(/<\/head>/i, `    ${ENV_TAG}\n  </head>`),
    },
    configureServer(server) {
      server.middlewares.use(routes);
    },
    configurePreviewServer(server) {
      server.middlewares.use(routes);
      // `vite preview` serves the built files as-is, so the env tag is injected here
      // exactly the way the platform does it.
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? "/").split("?")[0] ?? "/";
        const wantsHtml = path === "/" || path === "/index.html";
        if (req.method !== "GET" || !wantsHtml) {
          next();
          return;
        }
        try {
          const html = await readFile(resolve(ROOT, "dist/index.html"), "utf8");
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(html.includes(ENV_TAG) ? html : html.replace(/<\/head>/i, `    ${ENV_TAG}\n  </head>`));
        } catch {
          next();
        }
      });
    },
  };
}
