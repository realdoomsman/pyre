import type { Request, RequestHandler, Response } from "express";
import { ROBINHOOD_CHAIN_ID } from "@pyre/shared";
import { env } from "../env.js";
import { HttpError } from "../lib/errors.js";
import { enforceSameOrigin } from "../lib/origin.js";
import { clientIp, consumeRate, type RateBucket } from "../lib/ratelimit.js";
import { loadFile, serveStatic } from "./files.js";
import { applySecurityHeaders } from "./headers.js";
import { renderBuildingPage, renderDormantPage, renderKilledPage, renderNotFoundPage } from "./pages.js";
import { matchAppRequest, resolveApp, type HostContext, type RouteMatch } from "./resolve.js";
import { authExchange, authLogout } from "./routes/auth.js";
import { coinsRoute } from "./routes/coins.js";
import { callDepth, fnRoute } from "./routes/fn.js";
import { kvAppRoute, kvUserRoute } from "./routes/kv.js";
import { meRoute } from "./routes/me.js";
import { readVisitor, trackRoute } from "./routes/track.js";
import { SESSION_COOKIE, readCookie, verifySessionCookie } from "./session.js";

const PYRE_PREFIX = "/_pyre/";

/**
 * Runtime env for the app shell. Served as a file (not inline) because the app CSP is `script-src 'self'`.
 * `basePath` lets the SDK build same-origin URLs whether the app is host-routed or path-routed.
 * Chain facts (`chainId`, `tokenAddress`, `explorerUrl`) are informational: the browser never signs.
 */
function envScript(ctx: HostContext): string {
  const manifest = ctx.deployment?.manifest;
  const payload = {
    appId: ctx.app.id,
    slug: ctx.app.slug,
    name: ctx.app.name,
    ticker: ctx.app.ticker,
    chainId: ROBINHOOD_CHAIN_ID,
    tokenAddress: ctx.app.tokenAddress ?? "",
    explorerUrl: env.BLOCKSCOUT_URL,
    googleClientId: env.GOOGLE_CLIENT_ID,
    apiOrigin: env.API_ORIGIN,
    basePath: ctx.basePath,
    version: ctx.deployment?.version ?? 0,
    holderMin: manifest?.holderTier?.minHoldTokens ?? 0,
    functions: manifest?.functions ?? [],
    // Chain constant. Bundles built with the SDK that predates the payments removal refuse to boot
    // without it, and every deployed app keeps working after a platform change, so it stays.
    usdg: env.USDG_ADDRESS,
  };
  // `</script>` can never appear in the payload, even if an app name tries.
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
 * per caller) because they occupy the shared QuickJS pool. Cookie identities (user, visitor) are
 * charged alongside the client IP: `/_pyre/track` mints a visitor id for any cookieless POST, so
 * an identity alone would let one IP multiply its quota by minting ids.
 */
async function limitPyre(ctx: HostContext, req: Request, res: Response, head: string | undefined, name: string | undefined): Promise<void> {
  const identity = pyreIdentity(req, ctx.app.id);
  const ip = `ip:${clientIp(req)}`;
  const identities = identity === ip ? [identity] : [identity, ip];
  const charge = async (bucket: RateBucket, prefix: string): Promise<void> => {
    for (const id of identities) await consumeRate(res, bucket, `${prefix}${id}`);
  };
  if (head === "fn") {
    await consumeRate(res, "appFnApp", `app:${ctx.app.id}`);
    // App-to-app `ship.fetch` hops all share the API's egress IP; the per-app bucket already bounds
    // them. Only a hop the platform signed counts — a bare header is refused, not trusted.
    if (callDepth(req, ctx.app.slug, name ?? "") === 0) await charge("appFnCaller", `${ctx.app.id}:`);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    await charge("read", `app:${ctx.app.id}:`);
    return;
  }
  await charge("appWrite", `${ctx.app.id}:`);
}

/** JSON platform endpoints living under every app origin. */
async function handlePyre(ctx: HostContext, req: Request, res: Response, pathname: string): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  // CSRF + app binding: a request must prove it came from this app's own origin and page (path-routed
  // apps share the API origin) before it touches state. The cookie itself is app-bound too: a
  // session minted under app X never verifies for app Y (`verifySessionCookie`).
  enforceSameOrigin(req, {
    origin: ctx.origin,
    basePath: ctx.basePath,
    appId: ctx.app.id,
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
  await limitPyre(ctx, req, res, head, second);

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
  } else if (head === "fn" && segments.length === 2 && second !== undefined) {
    requireMethod(req, res, "POST");
    return fnRoute(ctx, req, res, second);
  } else if (head === "track" && segments.length === 1) {
    requireMethod(req, res, "POST");
    return trackRoute(ctx, req, res);
  } else if (head === "screenshots" && segments.length === 2 && second !== undefined && /^[a-z0-9-]{1,40}\.png$/.test(second)) {
    // Verify-stage captures persisted with the deployment (`_pyre/screenshots/<label>.png`), public.
    requireMethod(req, res, "GET");
    const file = await loadFile(ctx, `_pyre/screenshots/${second}`);
    if (!file) throw new HttpError(404, "no such screenshot");
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.send(req.method === "HEAD" ? "" : file.body);
    return;
  } else if (head === "coins" && segments.length <= 3 && (third === undefined || third === "candles")) {
    requireMethod(req, res, "GET");
    return coinsRoute(ctx, req, res, second, third);
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
