import type { Request } from "express";
import { HttpError } from "./errors.js";

/**
 * CSRF defence for cookie-authenticated endpoints. App sessions live in a cookie on the app's own
 * origin, so a third-party page could otherwise POST to `/_pyre/*` with the user's credentials.
 * Path-routed apps additionally share one origin, so a request must also prove which app's page
 * it came from: `X-Pyre-App` (set by the SDK) must name this app, and a credentialed mutation
 * must carry either that header or a `Referer` under this app's base path.
 */
const MUTATING_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };

/** Custom header naming the app the page believes it belongs to; must match the resolved app when present. */
export const APP_HEADER = "x-pyre-app";

export interface OriginPolicy {
  /** Public origin of the app (scheme + host), e.g. `https://demo.pyre.fun` or the API origin. */
  origin: string;
  /** "" when host-routed, "/a/<slug>" when path-routed. */
  basePath: string;
  /** The resolved app; `X-Pyre-App`, when sent, must equal it. */
  appId: string;
  /** True when the request presents an ambient credential (the app session cookie). */
  credentialed: boolean;
}

const header = (req: Request, name: string): string | null => {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
};

const normalizeOrigin = (value: string): string | null => {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
};

/** Returns a rejection reason, or null when the request provably originates from the app itself. */
function reject(req: Request, policy: OriginPolicy): string | null {
  // A page that names an app must name this one, on every method: a cookie minted under /a/x is
  // never usable by a page that says it is /a/y, even for reads.
  const claimedApp = header(req, APP_HEADER);
  if (claimedApp !== null && claimedApp !== policy.appId) return "app_mismatch";

  if (!MUTATING_METHODS[req.method]) return null;
  const expected = normalizeOrigin(policy.origin);
  if (!expected) return "origin_unresolvable";

  const origin = header(req, "origin");
  const site = header(req, "sec-fetch-site");
  const referer = header(req, "referer");

  if (referer !== null) {
    // Present on both same-origin fetches and cross-site form posts; when it is there, it must fit.
    let url: URL | null = null;
    try {
      url = new URL(referer);
    } catch {
      return "referer_malformed";
    }
    if (url.origin.toLowerCase() !== expected) return "referer_cross_origin";
    // Path-routed apps share one origin, so the referring page must sit under this app's base path.
    const base = policy.basePath;
    if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return "referer_outside_app";
  }

  // Same origin is not enough on the shared path-routed origin: a credentialed mutation must
  // prove its page (the SDK header or, since app pages send `Referrer-Policy: same-origin`, a
  // referer under the base path — checked above). Plain forms and no-cors fetches carry neither.
  if (policy.basePath && policy.credentialed && claimedApp === null && referer === null) return "app_unproven";

  if (origin !== null) return origin.toLowerCase() === expected ? null : "origin_mismatch";
  if (site !== null) return site.toLowerCase() === "same-origin" ? null : "sec_fetch_site_cross_origin";
  if (referer !== null) return null;

  // No browser provenance at all: a server-to-server call (app-to-app `ship.fetch`, SDK from a
  // backend). Those carry no cookie, so they cannot be a cross-site credential replay.
  return policy.credentialed ? "origin_missing" : null;
}

/** Throws 403 when a request cannot prove it came from this app's own origin and page. */
export function enforceSameOrigin(req: Request, policy: OriginPolicy): void {
  const reason = reject(req, policy);
  if (reason) throw new HttpError(403, "cross_origin_request_blocked", { reason });
}
