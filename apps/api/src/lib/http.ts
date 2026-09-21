import { createHash } from "node:crypto";
import type { Response } from "express";
import { z } from "zod";

/** Matches the app-level `json replacer`: BigInt is serialized as a decimal string. */
const jsonReplacer = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

/**
 * Canonical JSON with object keys in sorted order, so structurally equal payloads
 * hash identically no matter which code path built them (or which api instance did).
 */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(jsonReplacer("", value)) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const source = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(source).sort()) {
    const serialized = stableStringify(source[key]);
    if (serialized !== undefined) parts.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${parts.join(",")}}`;
};

/** Strong ETag over the canonical form of a payload. */
export const etagOf = (payload: unknown): string =>
  `"${createHash("sha1").update(stableStringify(payload)).digest("base64url")}"`;

/** RFC 9110 If-None-Match: `*`, or a comma-separated list; weak prefixes compare as their opaque tag. */
const ifNoneMatchHits = (header: string | undefined, etag: string): boolean => {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  for (const candidate of header.split(",")) {
    const tag = candidate.trim();
    if (tag === etag || (tag.startsWith("W/") && tag.slice(2) === etag)) return true;
  }
  return false;
};

export interface CachePolicy {
  /** Shared/browser cache lifetime in seconds. */
  maxAge: number;
  /** `stale-while-revalidate` window in seconds; defaults to 4x maxAge. */
  swr?: number;
  /** Viewer-specific payload: never stored, never revalidated by a shared cache. */
  private?: boolean;
}

/**
 * Sends a JSON payload with a strong ETag and an explicit caching policy, answering
 * `304 Not Modified` when the client already holds the current representation.
 * Private payloads (anything derived from the caller's identity) are sent `no-store`.
 */
export const sendCached = (res: Response, payload: unknown, policy: CachePolicy): void => {
  res.setHeader("Vary", "Accept-Encoding, Authorization");
  if (policy.private === true) {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(payload);
    return;
  }
  const etag = etagOf(payload);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", `public, max-age=${policy.maxAge}, stale-while-revalidate=${policy.swr ?? policy.maxAge * 4}`);
  if (ifNoneMatchHits(res.req.headers["if-none-match"], etag)) {
    res.status(304).end();
    return;
  }
  res.json(payload);
};

/* ──────────────────────────────── query ceilings ──────────────────────────────── */

/** cuid/cuid-like row ids; anything else is a malformed cursor and gets a 400. */
const Cursor = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "malformed cursor")
  .optional();

/**
 * Cursor-paged list query with a hard server-side ceiling. Absurd `limit` values are
 * rejected with 400 instead of being clamped silently, so a client cannot discover
 * that it asked for something the API refuses to serve.
 */
export const pageQuery = (defaultLimit: number, maxLimit: number) =>
  z.object({
    cursor: Cursor,
    limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  });

/** Page size for endpoints that return a full window with no cursor (ledger, queue, holders). */
export const sizeQuery = (defaultSize: number, maxSize: number) =>
  z.object({ limit: z.coerce.number().int().min(1).max(maxSize).default(defaultSize) });
