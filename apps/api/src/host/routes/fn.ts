import type { Request, Response } from "express";
import type { Address } from "viem";
import { type User } from "@pyre/db";
import { env } from "../../env.js";
import { custodialUsdgBalance } from "../../lib/custodial.js";
import { HttpError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { readJson } from "../body.js";
import { loadFile } from "../files.js";
import { holderInfo } from "../holder.js";
import { appLlm } from "../llm.js";
import { chargeUsdg, sendInsufficientFunds } from "../payments.js";
import { runFunction, scheduleFunction, serializeResult, type HostApi } from "../quickjs.js";
import type { HostContext } from "../resolve.js";
import { recordRevenue } from "../revenue.js";
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
export const DEPTH_HEADER = "x-pyre-fn-depth";

const API_ORIGIN_URL = new URL(env.API_ORIGIN);
const HOSTED_FN_PATH = /^\/_pyre\/fn\/[a-z0-9_-]{1,40}$/;
const PATH_ROUTED_FN_PATH = /^\/a\/[a-z0-9-]{1,40}\/_pyre\/fn\/[a-z0-9_-]{1,40}$/;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

/**
 * Only other Pyre functions are reachable: `https://<slug>.<APP_DOMAIN>/_pyre/fn/<name>` when apps are
 * host-routed, and `<API_ORIGIN>/a/<slug>/_pyre/fn/<name>` when they are path-routed.
 */
export function allowedTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ship.fetch: invalid URL");
  }
  if (url.search || url.hash) throw new Error("ship.fetch: query strings are not allowed");
  if (url.origin === API_ORIGIN_URL.origin && PATH_ROUTED_FN_PATH.test(url.pathname)) return url;
  if (env.APP_DOMAIN && url.protocol === "https:" && HOSTED_FN_PATH.test(url.pathname)) {
    const suffix = `.${env.APP_DOMAIN.toLowerCase()}`;
    const host = url.hostname.toLowerCase();
    if (host.endsWith(suffix) && /^[a-z0-9-]{1,40}$/.test(host.slice(0, -suffix.length))) return url;
  }
  throw new Error("ship.fetch: only other Pyre app functions may be called");
}

async function pyreFetch(raw: unknown, body: unknown, depth: number): Promise<unknown> {
  if (depth >= MAX_DEPTH) throw new Error("ship.fetch: app-to-app call depth exceeded");
  const target = allowedTarget(requireString(raw, "ship.fetch: url"));
  let response: globalThis.Response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", [DEPTH_HEADER]: String(depth + 1) },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`ship.fetch: ${target.host} unreachable (${err instanceof Error ? err.message : String(err)})`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_FETCH_BYTES) throw new Error("ship.fetch: response too large");
  if (!response.ok) throw new Error(`ship.fetch: ${target.host} returned ${response.status}`);
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

/**
 * Charges the x402 price for one call: the caller's custodial wallet signs a USDG EIP-3009
 * authorization server-side and the treasury relays it. Returns false when a 402 was already sent,
 * true when the call may proceed. There is no client-signed payment header, no replay lock: the
 * platform holds the wallet and pays.
 */
async function settlePayment(
  ctx: HostContext,
  res: Response,
  user: User | null,
  name: string,
  priceMicros: bigint,
): Promise<boolean> {
  if (!user) throw new HttpError(401, "sign in required");
  if (!user.wallet) throw new HttpError(503, "wallet is not ready yet");
  const wallet = user.wallet as Address;

  const balance = await custodialUsdgBalance(wallet);
  if (balance < priceMicros) {
    sendInsufficientFunds(res, priceMicros, balance, wallet);
    return false;
  }

  let txHash: string;
  try {
    txHash = await chargeUsdg(user, priceMicros);
  } catch (err) {
    logger.error({ err, appId: ctx.app.id, name }, "host: x402 payment failed");
    throw new HttpError(502, "payment_failed");
  }

  await recordRevenue({
    app: { id: ctx.app.id, slug: ctx.app.slug },
    source: "X402",
    usdMicros: priceMicros,
    payer: wallet,
    reference: txHash,
    label: `x402: ${name}`,
  });
  return true;
}

/** `POST /_pyre/fn/:name` — runs `functions/<name>.js` from the live deployment inside QuickJS. */
export async function fnRoute(ctx: HostContext, req: Request, res: Response, name: string): Promise<void> {
  const deployment = ctx.deployment;
  if (!deployment) throw new HttpError(503, "app is not deployed yet");
  const spec = deployment.manifest.functions.find((f) => f.name === name);
  if (!spec) throw new HttpError(404, "unknown function");

  const depthHeader = req.headers[DEPTH_HEADER];
  const depth = Number(Array.isArray(depthHeader) ? depthHeader[0] : (depthHeader ?? 0));
  if (!Number.isFinite(depth) || depth < 0 || depth > MAX_DEPTH) throw new HttpError(400, "function call depth exceeded");

  const user = await currentUser(req, ctx.app.id);
  if (spec.auth && !user) throw new HttpError(401, "sign in required");
  const holder = user || spec.holderOnly ? await holderInfo(ctx, user?.wallet) : null;
  if (spec.holderOnly && !holder?.isHolder) throw new HttpError(403, "holders only");

  const priceMicros = BigInt(Math.round(spec.priceUsd * 1e6));
  if (priceMicros > 0n && !(await settlePayment(ctx, res, user, name, priceMicros))) return;

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
