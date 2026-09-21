import type { Request } from "express";
import { prisma, type App } from "@pyre/db";
import { PyreManifest } from "@pyre/shared";
import { env } from "../env.js";

export interface LiveDeployment {
  id: string;
  version: number;
  manifest: PyreManifest;
}

export interface HostContext {
  app: App;
  deployment: LiveDeployment | null;
  /** "" when host-routed, "/a/<slug>" when path-routed. */
  basePath: string;
  /** Public origin of this app (scheme + host), used for absolute URLs. */
  origin: string;
}

export interface RouteMatch {
  slug: string;
  basePath: string;
  /** Path + query relative to the app root, always starting with "/". */
  url: string;
}

const SLUG_RE = /^[a-z0-9-]{1,40}$/;

/**
 * Platform-owned labels that can never be an app slug, so `api.<APP_DOMAIN>` (and friends) reach the
 * platform API and web rather than resolving to a non-existent app when APP_DOMAIN is the apex.
 */
const RESERVED_SUBDOMAINS: Record<string, true> = { api: true, www: true, app: true, apps: true, admin: true, assets: true, static: true, cdn: true, mail: true, ftp: true, ns: true, mx: true };

/** Detects `<slug>.<APP_DOMAIN>` hosts or `/a/<slug>` prefixes. Returns null for non-app requests. */
export function matchAppRequest(req: Request): RouteMatch | null {
  const url = req.url;
  if (url.startsWith("/a/")) {
    const end = url.indexOf("/", 3);
    const qs = url.indexOf("?", 3);
    const stop = end === -1 ? (qs === -1 ? url.length : qs) : qs !== -1 && qs < end ? qs : end;
    const slug = url.slice(3, stop);
    if (SLUG_RE.test(slug) && !RESERVED_SUBDOMAINS[slug]) return { slug, basePath: `/a/${slug}`, url: url.slice(stop) || "/" };
  }
  if (!env.APP_DOMAIN) return null;
  const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${env.APP_DOMAIN.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  if (!SLUG_RE.test(slug) || RESERVED_SUBDOMAINS[slug]) return null;
  return { slug, basePath: "", url };
}

interface CacheEntry {
  app: App | null;
  deployment: LiveDeployment | null;
  expires: number;
}

const APP_TTL_MS = 30_000;
const MISS_TTL_MS = 10_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

async function load(slug: string): Promise<CacheEntry> {
  const app = await prisma.app.findUnique({ where: { slug } });
  if (!app) return { app: null, deployment: null, expires: Date.now() + MISS_TTL_MS };
  let deployment: LiveDeployment | null = null;
  if (app.liveVersion > 0) {
    const row = await prisma.deployment.findUnique({
      where: { appId_version: { appId: app.id, version: app.liveVersion } },
      select: { id: true, version: true, manifest: true },
    });
    if (row) {
      const parsed = PyreManifest.safeParse(row.manifest);
      deployment = {
        id: row.id,
        version: row.version,
        manifest: parsed.success ? parsed.data : PyreManifest.parse({ name: app.name }),
      };
    }
  }
  return { app, deployment, expires: Date.now() + APP_TTL_MS };
}

export async function resolveApp(slug: string): Promise<{ app: App | null; deployment: LiveDeployment | null }> {
  const hit = cache.get(slug);
  if (hit && hit.expires > Date.now()) return hit;
  let p = inflight.get(slug);
  if (!p) {
    p = load(slug).finally(() => inflight.delete(slug));
    inflight.set(slug, p);
    p.then((entry) => {
      cache.set(slug, entry);
      if (cache.size > 5000) {
        const now = Date.now();
        for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
      }
    }).catch(() => {});
  }
  return p;
}

/** Drop a cached slug (e.g. after this process changed the app row). */
export function invalidateApp(slug: string): void {
  cache.delete(slug);
}
