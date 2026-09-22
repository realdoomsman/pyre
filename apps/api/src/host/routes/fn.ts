import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../env.js";
import { HttpError } from "../../lib/errors.js";
import { readJson } from "../body.js";
import { loadFile } from "../files.js";
import { holderInfo } from "../holder.js";
import { appLlm } from "../llm.js";
import { runFunction, scheduleFunction, serializeResult, type HostApi } from "../quickjs.js";
import type { HostContext } from "../resolve.js";
import { currentUser } from "../session.js";
import { APP_SCOPE, kvDelete, kvRead, kvWrite } from "./kv.js";

/** Guest CPU deadline (interrupt handler) and total wall budget including awaited host calls. */
const FN_CPU_MS = 5_000;
const FN_WALL_MS = 20_000;
const FN_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_BYTES = 128 * 1024;

/** App-to-app `ship.fetch` limits. */
const MAX_DEPTH = 2;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_FETCH_BYTES = 256 * 1024;
/**
 * `<depth>.<issuedMs>.<mac>` on internal `ship.fetch` hops. The MAC (INTERNAL_SECRET over depth,
 * time, target slug and function) is what makes the depth trustworthy: a browser cannot mint one,
 * so it cannot pose as an internal hop to skip the per-caller limit or shorten the depth budget.
 */
export const DEPTH_HEADER = "x-pyre-fn-depth";
const DEPTH_TTL_MS = 60_000;

const depthMac = (depth: number, issued: number, slug: string, name: string): Buffer =>
  createHmac("sha256", env.INTERNAL_SECRET).update(`${depth}.${issued}.${slug}.${name}`).digest();

/** Header value for an internal hop at `depth` into `slug`'s function `name`. */
export function signDepth(depth: number, slug: string, name: string): string {
  const issued = Date.now();
  return `${depth}.${issued}.${depthMac(depth, issued, slug, name).toString("base64url")}`;
}

/**
 * Depth of the current call: 0 for a browser/SDK call (no header), else the signed depth of an
 * internal `ship.fetch` hop. A present-but-unsigned or stale header is a 403, never a downgrade.
 */
export function callDepth(req: Request, slug: string, name: string): number {
  const raw = req.headers[DEPTH_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return 0;
  const parts = value.split(".");
  const depth = Number(parts[0]);
  const issued = Number(parts[1]);
  if (parts.length !== 3 || !Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH || !Number.isFinite(issued)) {
    throw new HttpError(403, "bad function call depth");
  }
  if (Math.abs(Date.now() - issued) > DEPTH_TTL_MS) throw new HttpError(403, "bad function call depth");
  const expected = depthMac(depth, issued, slug, name);
  const given = Buffer.from(parts[2]!, "base64url");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(403, "bad function call depth");
  return depth;
}

const API_ORIGIN_URL = new URL(env.API_ORIGIN);
const HOSTED_FN_PATH = /^\/_pyre\/fn\/[a-z0-9_-]{1,40}$/;
const PATH_ROUTED_FN_PATH = /^\/a\/[a-z0-9-]{1,40}\/_pyre\/fn\/[a-z0-9_-]{1,40}$/;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

/** The `{slug, name}` a verified target URL addresses. */
export interface FnTarget {
  url: URL;
  slug: string;
  name: string;
}

/**
 * Only other Pyre functions are reachable: `https://<slug>.<APP_DOMAIN>/_pyre/fn/<name>` when apps are
 * host-routed, and `<API_ORIGIN>/a/<slug>/_pyre/fn/<name>` when they are path-routed.
 */
export function allowedTarget(raw: string): FnTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ship.fetch: invalid URL");
  }
  if (url.search || url.hash) throw new Error("ship.fetch: query strings are not allowed");
  const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  if (url.origin === API_ORIGIN_URL.origin && PATH_ROUTED_FN_PATH.test(url.pathname)) {
    return { url, slug: url.pathname.slice(3, url.pathname.indexOf("/", 3)), name };
  }
  if (env.APP_DOMAIN && url.protocol === "https:" && HOSTED_FN_PATH.test(url.pathname)) {
    const suffix = `.${env.APP_DOMAIN.toLowerCase()}`;
    const host = url.hostname.toLowerCase();
    const slug = host.slice(0, -suffix.length);
    if (host.endsWith(suffix) && /^[a-z0-9-]{1,40}$/.test(slug)) return { url, slug, name };
  }
  throw new Error("ship.fetch: only other Pyre app functions may be called");
}

async function pyreFetch(raw: unknown, body: unknown, depth: number): Promise<unknown> {
  if (depth >= MAX_DEPTH) throw new Error("ship.fetch: app-to-app call depth exceeded");
  const target = allowedTarget(requireString(raw, "ship.fetch: url"));
  let response: globalThis.Response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", [DEPTH_HEADER]: signDepth(depth + 1, target.slug, target.name) },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`ship.fetch: ${target.url.host} unreachable (${err instanceof Error ? err.message : String(err)})`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_FETCH_BYTES) throw new Error("ship.fetch: response too large");
  if (!response.ok) throw new Error(`ship.fetch: ${target.url.host} returned ${response.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("ship.fetch: response was not JSON");
  }
  // Pyre functions answer `{result: …}`; hand the guest the payload itself.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "result" in parsed) return parsed.result;
  return parsed;
}

/** `POST /_pyre/fn/:name` — runs `functions/<name>.js` from the live deployment inside QuickJS. */
export async function fnRoute(ctx: HostContext, req: Request, res: Response, name: string): Promise<void> {
  const deployment = ctx.deployment;
  if (!deployment) throw new HttpError(503, "app is not deployed yet");
  const spec = deployment.manifest.functions.find((f) => f.name === name);
  if (!spec) throw new HttpError(404, "unknown function");

  const depth = callDepth(req, ctx.app.slug, name);

  const user = await currentUser(req, ctx.app.id);
  if (spec.auth && !user) throw new HttpError(401, "sign in required");
  const holder = user || spec.holderOnly ? await holderInfo(ctx, user) : null;
  if (spec.holderOnly && !holder?.isHolder) throw new HttpError(403, "holders only");

  const input = await readJson(req, MAX_INPUT_BYTES);
  const file = await loadFile(ctx, `functions/${name}.js`);
  if (!file) throw new HttpError(404, "function is not in this deployment");

  const appId = ctx.app.id;
  const api: HostApi = {
    // Always an object so guests can read `ship.user.id` (null when anonymous) without a guard.
    user: { id: user?.id ?? null, wallet: user?.wallet ?? null, isHolder: holder?.isHolder ?? false },
    input,
    kv: {
      get: async (key: unknown) => kvRead(appId, APP_SCOPE, requireString(key, "ship.kv.get: key")),
      set: async (key: unknown, value: unknown) => {
        await kvWrite(appId, APP_SCOPE, requireString(key, "ship.kv.set: key"), value);
        return true;
      },
      del: async (key: unknown) => kvDelete(appId, APP_SCOPE, requireString(key, "ship.kv.del: key")),
    },
    fetch: async (url: unknown, body: unknown) => pyreFetch(url, body, depth),
    llm: async (prompt: unknown, options: unknown) => {
      let maxTokens: number | undefined;
      if (options != null) {
        if (typeof options !== "object" || Array.isArray(options)) throw new Error("ship.llm: options must be an object");
        if ("maxTokens" in options) {
          const raw = options.maxTokens;
          if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("ship.llm: maxTokens must be a number");
          maxTokens = raw;
        }
      }
      return appLlm(appId, requireString(prompt, "ship.llm: prompt"), maxTokens);
    },
  };

  const result = await scheduleFunction(appId, () =>
    runFunction({
      source: file.body.toString("utf8"),
      filename: `${name}.js`,
      input,
      api,
      cpuMs: FN_CPU_MS,
      wallMs: FN_WALL_MS,
      memoryBytes: FN_MEMORY_BYTES,
    }),
  );
  res.type("application/json").send(`{"result":${serializeResult(result)}}`);
}
