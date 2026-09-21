import type { Request, RequestHandler, Response } from "express";
import { usdgAddress } from "@pyre/chain";
import { ROBINHOOD_CHAIN_ID } from "@pyre/shared";
import { env } from "../env.js";
import { HttpError } from "../lib/errors.js";
import { enforceSameOrigin } from "../lib/origin.js";
import { clientIp, consumeRate } from "../lib/ratelimit.js";
import { TREASURY_WALLET } from "../lib/treasury.js";
import { serveStatic } from "./files.js";
import { applySecurityHeaders } from "./headers.js";
import { renderBuildingPage, renderDormantPage, renderKilledPage, renderNotFoundPage } from "./pages.js";
import { matchAppRequest, resolveApp, type HostContext, type RouteMatch } from "./resolve.js";
import { adClickRoute, adRoute } from "./routes/ad.js";
import { authExchange, authLogout } from "./routes/auth.js";
import { checkoutStart } from "./routes/checkout.js";
import { DEPTH_HEADER, fnRoute } from "./routes/fn.js";
import { kvAppRoute, kvUserRoute } from "./routes/kv.js";
import { meRoute } from "./routes/me.js";
import { readVisitor, trackRoute } from "./routes/track.js";
import { SESSION_COOKIE, readCookie, verifySessionCookie } from "./session.js";

const PYRE_PREFIX = "/_pyre/";

/**
 * Runtime env for the app shell. Served as a file (not inline) because the app CSP is `script-src 'self'`.
 * `basePath` lets the SDK build same-origin URLs whether the app is host-routed or path-routed.
 * Chain facts (`chainId`, `usdg`, `treasury`, `tokenAddress`, `explorerUrl`) are informational: the
 * browser never signs, every payment is settled server-side from the user's custodial wallet.
 */
function envScript(ctx: HostContext): string {
  const manifest = ctx.deployment?.manifest;
  const payload = {
    appId: ctx.app.id,
    slug: ctx.app.slug,
    name: ctx.app.name,
    ticker: ctx.app.ticker,
    chainId: ROBINHOOD_CHAIN_ID,
    usdg: usdgAddress(),
    treasury: TREASURY_WALLET,
    tokenAddress: ctx.app.tokenAddress ?? "",
    explorerUrl: env.BLOCKSCOUT_URL,
    googleClientId: env.GOOGLE_CLIENT_ID,
    apiOrigin: env.API_ORIGIN,
    basePath: ctx.basePath,
    version: ctx.deployment?.version ?? 0,
    holderMin: manifest?.holderTier?.minHoldTokens ?? 0,
    adSlot: manifest?.adSlot ?? false,
    products: manifest?.products ?? [],
    functions: manifest?.functions ?? [],
  };
  // `</script>` can never appear in the payload, even if a product name tries.
  return `window.__PYRE__ = ${JSON.stringify(payload).replace(/</g, "\\u003c")};\nObject.freeze(window.__PYRE__);\n`;
}

function requireMethod(req: Request, res: Response, allow: string): void {
  if (req.method === allow) return;
  if (allow === "GET" && req.method === "HEAD") return;
  res.setHeader("Allow", allow);
  throw new HttpError(405, "method not allowed");
}

/**
 * Rate-limit identity inside an app: the session cookie's user when present (verified, no DB hit),
 * else the signed visitor cookie, else the proxied client IP. Both cookies are HMAC-verified, and a
 * caller that omits them falls back to the IP bucket — dropping a cookie never buys extra quota.
 */
function pyreIdentity(req: Request, appId: string): string {
  const raw = readCookie(req, SESSION_COOKIE);
  const userId = raw ? verifySessionCookie(raw, appId) : null;
  if (userId) return `u:${userId}`;
  const visitor = readVisitor(req);
  return visitor ? `v:${visitor}` : `ip:${clientIp(req)}`;
}

/**
 * Per-class limits for the app platform endpoints. Function calls are bounded twice (per app and
 * per caller) because they occupy the shared QuickJS pool.
 */
async function limitPyre(ctx: HostContext, req: Request, res: Response, head: string | undefined): Promise<void> {
  const identity = pyreIdentity(req, ctx.app.id);
  if (head === "fn") {
    await consumeRate(res, "appFnApp", `app:${ctx.app.id}`);
    // App-to-app `ship.fetch` hops all share the API's egress IP; the per-app bucket already bounds them.
    if (req.headers[DEPTH_HEADER] === undefined) await consumeRate(res, "appFnCaller", `${ctx.app.id}:${identity}`);
    return;
  }
  if (head === "checkout" && req.method === "POST") {
    await consumeRate(res, "checkout", `${ctx.app.id}:${identity}`);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    await consumeRate(res, "read", `app:${ctx.app.id}:${identity}`);
    return;
  }
  await consumeRate(res, "appWrite", `${ctx.app.id}:${identity}`);
}

/** JSON platform endpoints living under every app origin. */
async function handlePyre(ctx: HostContext, req: Request, res: Response, pathname: string): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  // CSRF: a mutating request must prove it came from this app's own origin before it touches state.
  enforceSameOrigin(req, {
    origin: ctx.origin,
    basePath: ctx.basePath,
    credentialed: readCookie(req, SESSION_COOKIE) !== null,
  });
  if (ctx.app.status === "DORMANT") throw new HttpError(503, "app is out of budget");
  if (!ctx.deployment) throw new HttpError(503, "app is not deployed yet");

  const segments: string[] = [];
  for (const part of pathname.slice(PYRE_PREFIX.length).split("/")) {
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      throw new HttpError(400, "bad path");
    }
  }
  const [head, second, third] = segments;
  await limitPyre(ctx, req, res, head);

  if (head === "env.js" && segments.length === 1) {
    requireMethod(req, res, "GET");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.send(req.method === "HEAD" ? "" : envScript(ctx));
    return;
  }
  if (head === "auth" && segments.length === 2) {
    requireMethod(req, res, "POST");
    if (second === "exchange") return authExchange(ctx, req, res);
    if (second === "logout") return authLogout(ctx, req, res);
  } else if (head === "me" && segments.length === 1) {
    requireMethod(req, res, "GET");
    return meRoute(ctx, req, res);
  } else if (head === "kv" && segments.length === 2 && second !== undefined) {
    return kvUserRoute(ctx, req, res, second);
  } else if (head === "kv" && segments.length === 3 && second === "app" && third !== undefined) {
    return kvAppRoute(ctx, req, res, third);
  } else if (head === "checkout" && segments.length === 1) {
    requireMethod(req, res, "POST");
    return checkoutStart(ctx, req, res);
  } else if (head === "fn" && segments.length === 2 && second !== undefined) {
    requireMethod(req, res, "POST");
    return fnRoute(ctx, req, res, second);
  } else if (head === "ad" && segments.length === 1) {
    requireMethod(req, res, "GET");
    return adRoute(ctx, req, res);
  } else if (head === "ad" && segments.length === 3 && second === "click" && third !== undefined) {
    requireMethod(req, res, "GET");
    return adClickRoute(ctx, req, res, third);
  } else if (head === "track" && segments.length === 1) {
    requireMethod(req, res, "POST");
    return trackRoute(ctx, req, res);
  }
  throw new HttpError(404, "unknown platform endpoint");
}

async function handleApp(match: RouteMatch, req: Request, res: Response): Promise<void> {
  const { app, deployment } = await resolveApp(match.slug);
  applySecurityHeaders(res);
  const query = match.url.indexOf("?");
  const pathname = query === -1 ? match.url : match.url.slice(0, query);
  const isPyre = pathname.startsWith(PYRE_PREFIX);

  if (!app) {
    if (isPyre) {
      res.status(404).json({ error: "unknown app" });
      return;
    }
    res.status(404).setHeader("Cache-Control", "no-store");
    res.type("html").send(renderNotFoundPage(match.slug));
    return;
  }
  if (app.status === "KILLED") {
    res.status(410).setHeader("Cache-Control", "no-store");
    if (isPyre) res.json({ error: "app removed" });
    else res.type("html").send(renderKilledPage(app));
    return;
  }

  const requestUrl = req.url;
  // Mount semantics: from here on `req.path`/`req.query` are relative to the app root.
  req.url = match.url;
  const ctx: HostContext = {
    app,
    deployment,
    basePath: match.basePath,
    origin: match.basePath ? env.API_ORIGIN : `${req.protocol}://${req.headers.host ?? ""}`,
  };
  if (isPyre) return handlePyre(ctx, req, res, pathname);

  // `/a/<slug>` without the trailing slash: relative links below it would resolve against `/a/`.
  if (match.basePath && !requestUrl.slice(match.basePath.length).startsWith("/")) {
    res.redirect(302, `${match.basePath}/${query === -1 ? "" : match.url.slice(query)}`);
    return;
  }
  if (app.status === "DORMANT") {
    res.status(200).setHeader("Cache-Control", "no-store");
    res.type("html").send(renderDormantPage(app));
    return;
  }
  if (!deployment) {
    res.status(200).setHeader("Cache-Control", "no-store");
    res.type("html").send(renderBuildingPage(app));
    return;
  }
  return serveStatic(ctx, req, res);
}

/** Serves every app request (`<slug>.<APP_DOMAIN>` or `/a/<slug>`); everything else falls through to the platform API. */
export const hostMiddleware: RequestHandler = (req, res, next) => {
  const match = matchAppRequest(req);
  if (!match) {
    next();
    return;
  }
  handleApp(match, req, res).catch(next);
};
