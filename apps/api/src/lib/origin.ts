import type { Request } from "express";
import { HttpError } from "./errors.js";

/**
 * CSRF defence for cookie-authenticated endpoints. App sessions live in a cookie on the app's own
 * origin, so a third-party page could otherwise POST to `/_pyre/*` with the user's credentials.
 */
const MUTATING_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };

export interface OriginPolicy {
  /** Public origin of the app (scheme + host), e.g. `https://demo.pyre.fun` or the API origin. */
  origin: string;
  /** "" when host-routed, "/a/<slug>" when path-routed. */
  basePath: string;
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

  if (origin !== null) return origin.toLowerCase() === expected ? null : "origin_mismatch";
  if (site !== null) return site.toLowerCase() === "same-origin" ? null : "sec_fetch_site_cross_origin";
  if (referer !== null) return null;

  // No browser provenance at all: a server-to-server call (app-to-app `ship.fetch`, SDK from a
  // backend). Those carry no cookie, so they cannot be a cross-site credential replay.
  return policy.credentialed ? "origin_missing" : null;
}

/** Throws 403 when a mutating request cannot prove it came from the app's own origin. */
export function enforceSameOrigin(req: Request, policy: OriginPolicy): void {
  const reason = reject(req, policy);
  if (reason) throw new HttpError(403, "cross_origin_request_blocked", { reason });
}
