import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "@pyre/db";
import type { HostContext } from "./resolve.js";

export interface ServedFile {
  body: Buffer;
  etag: string;
  contentType: string;
}

const MAX_CACHED_FILE = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const cache = new Map<string, ServedFile | null>();
let cacheBytes = 0;

function remember(key: string, file: ServedFile | null): void {
  if (file && file.body.length > MAX_CACHED_FILE) return;
  const prev = cache.get(key);
  if (prev) cacheBytes -= prev.body.length;
  cache.delete(key);
  cache.set(key, file);
  cacheBytes += file?.body.length ?? 0;
  while (cacheBytes > MAX_CACHE_BYTES && cache.size > 0) {
    const [oldest, entry] = cache.entries().next().value as [string, ServedFile | null];
    cache.delete(oldest);
    cacheBytes -= entry?.body.length ?? 0;
  }
}

/**
 * Rewrites the built index.html so it works at both `<slug>.domain/` and `/a/<slug>/`:
 * Vite emits `./assets/...` (base "./"), which we anchor to the app root so deep links resolve,
 * and we inject the runtime env script before </head>. (`<base>` is off the table: CSP base-uri 'none'.)
 */
export function rewriteHtml(html: string, basePath: string): string {
  const root = `${basePath}/`;
  // One pass: chaining two replaces would re-prefix the URLs the first one just made absolute.
  // `//cdn…` (protocol-relative) is left alone.
  const out = html.replace(/(\s(?:src|href)=)(["'])(?:\.\/|\/(?!\/))/gi, `$1$2${root}`);
  const tag = `<script src="${basePath}/_pyre/env.js"></script>`;
  const head = out.search(/<\/head>/i);
  return head === -1 ? tag + out : out.slice(0, head) + tag + out.slice(head);
}

/** Loads a DeployFile of the live deployment (path without leading slash). Cached per deployment. */
export async function loadFile(ctx: HostContext, path: string): Promise<ServedFile | null> {
  const deployment = ctx.deployment;
  if (!deployment) return null;
  const isHtml = path.endsWith(".html");
  const key = `${deployment.id}\0${path}\0${isHtml ? ctx.basePath : ""}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const row = await prisma.deployFile.findUnique({
    where: { deploymentId_path: { deploymentId: deployment.id, path } },
    select: { body: true, contentType: true },
  });
  if (!row) {
    remember(key, null);
    return null;
  }
  const body = isHtml
    ? Buffer.from(rewriteHtml(Buffer.from(row.body).toString("utf8"), ctx.basePath), "utf8")
    : Buffer.from(row.body);
  const file: ServedFile = {
    body,
    etag: `"${createHash("sha1").update(body).digest("base64url")}"`,
    contentType: row.contentType || "application/octet-stream",
  };
  remember(key, file);
  return file;
}

export function sendFile(req: Request, res: Response, file: ServedFile, cacheControl: string): void {
  res.setHeader("ETag", file.etag);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Vary", "Accept-Encoding");
  if (req.headers["if-none-match"] === file.etag) {
    res.status(304).end();
    return;
  }
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Length", String(file.body.length));
  if (req.method === "HEAD") res.end();
  else res.end(file.body);
}

/** Normalizes a request path to a DeployFile path. Returns null on traversal / bad encoding. */
export function toFilePath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter((s) => s.length > 0);
  for (const s of segments) if (s === "." || s === ".." || s.includes("\\") || s.includes("\0")) return null;
  return segments.join("/");
}

/** Static asset serving with SPA fallback for the live deployment. */
export async function serveStatic(ctx: HostContext, req: Request, res: Response): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const path = toFilePath(req.path);
  if (path === null) {
    res.status(400).json({ error: "bad path" });
    return;
  }
  if (path.startsWith("_pyre/") || path.startsWith("functions/") || path === "pyre.manifest.json") {
    res.status(404).json({ error: "not found" });
    return;
  }
  const entry = ctx.deployment?.manifest.entry || "index.html";
  const direct = path === "" ? entry : path;
  let file = await loadFile(ctx, direct);
  let served = direct;
  if (!file) {
    const last = path.slice(path.lastIndexOf("/") + 1);
    const looksLikeAsset = last.includes(".") && !last.endsWith(".html");
    if (looksLikeAsset) {
      res.status(404).setHeader("Cache-Control", "no-cache");
      res.json({ error: "not found" });
      return;
    }
    file = await loadFile(ctx, entry);
    served = entry;
    if (!file) {
      res.status(404).json({ error: "no entry file in deployment" });
      return;
    }
  }
  const cacheControl = served.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : served.endsWith(".html")
      ? "no-cache"
      : "public, max-age=300";
  sendFile(req, res, file, cacheControl);
}
