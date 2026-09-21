import { createHash, randomBytes } from "node:crypto";
import type { Callback, Result } from "ioredis";
import type { Request, RequestHandler, Response } from "express";
import { HttpError } from "./errors.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";

/**
 * Redis-backed sliding-window limiter. One sorted set per (class, identity): entries are request
 * timestamps, the window is trimmed on every call and the whole check is a single atomic script so
 * every api instance shares one budget.
 */
const SLIDING_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = (tonumber(oldest[2]) + window) - now end
  if retry < 0 then retry = 0 end
  return {0, count, math.ceil(retry)}
end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return {1, count + 1, 0}
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    pyreSlidingWindow(
      key: string,
      nowMs: string,
      windowMs: string,
      limit: string,
      member: string,
      callback?: Callback<[number, number, number]>,
    ): Result<[number, number, number], Context>;
  }
}

redis.defineCommand("pyreSlidingWindow", { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });

export interface RateTier {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

/**
 * Route classes. Writes are deliberately generous enough for a human hammering the UI and tight
 * enough that a script cannot enqueue thousands of jobs, votes or escrow verifications.
 */
export const RATE_TIERS = {
  /** Mutations: queue submissions, votes, bounties, stakes, approvals, maintainer votes. */
  write: { limit: 30, windowMs: 60_000 },
  /** Launch + fork creation. The reputation-tier daily cap in lib/launch.ts still applies on top. */
  launch: { limit: 10, windowMs: 3_600_000 },
  /** Abuse reports — matches the pre-existing 5/hour cap, now shared across instances. */
  report: { limit: 5, windowMs: 3_600_000 },
  read: { limit: 300, windowMs: 60_000 },
  admin: { limit: 600, windowMs: 60_000 },
  /** Providers retry, so this only exists to blunt an unauthenticated flood. */
  webhook: { limit: 600, windowMs: 60_000 },
  /** `/_pyre/fn/:name` per caller. */
  appFnCaller: { limit: 60, windowMs: 60_000 },
  /** `/_pyre/fn/:name` per app, across all callers: protects the shared QuickJS pool. */
  appFnApp: { limit: 600, windowMs: 60_000 },
  /** Cookie-authenticated app writes: kv puts/deletes, track beacons, auth exchange. */
  appWrite: { limit: 120, windowMs: 60_000 },
  /** Checkout creation reserves a Purchase row and burns an RPC blockhash. */
  checkout: { limit: 10, windowMs: 60_000 },
  /** Anthropic proxy, per job token. */
  proxy: { limit: 240, windowMs: 60_000 },
  /** Anthropic proxy, per source IP — a fail-closed pre-auth floor so invalid tokens can't flood the token lookup. */
  proxyIp: { limit: 600, windowMs: 60_000 },
  /** Money leaving the platform (withdraw + fee/staker claims): tight — no human needs 10+/min. */
  payout: { limit: 10, windowMs: 60_000 },
  /** Platform-governance proposal submissions: a handful an hour keeps the public board clean. */
  proposal: { limit: 6, windowMs: 3_600_000 },
  /** Coin-image uploads persist bytes in Postgres; a launch needs one, so a handful/hour blunts blob-spam. */
  upload: { limit: 20, windowMs: 3_600_000 },
  /** Login attempts (Google token / wallet challenge + verify), per IP or address. Fails closed. */
  auth: { limit: 30, windowMs: 60_000 },
  /** Read-only JSON-RPC proxy: per IP, so a page's balance polling fits but a scraper's fan-out does not. */
  rpc: { limit: 120, windowMs: 60_000 },
  /** Custodial trades + quotes: each trade is a server-signed transaction; quotes are multicalls. */
  trade: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<string, RateTier>;

export type RateBucket = keyof typeof RATE_TIERS;

let counter = 0;

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Security-critical buckets fail CLOSED: if the limiter is unreachable we deny rather than let an
 * attacker drain the treasury or brute-force auth while Redis is down. Everything else fails open.
 */
const FAIL_CLOSED_BUCKETS: Record<string, true> = { payout: true, auth: true, proposal: true, proxyIp: true };

/** Fails open for guardrail buckets, closed for the security-critical ones (see FAIL_CLOSED_BUCKETS). */
export async function checkRate(bucket: string, identity: string, tier: RateTier): Promise<RateDecision> {
  const now = Date.now();
  try {
    const [allowed, count, retryMs] = await redis.pyreSlidingWindow(
      `rl:${bucket}:${identity}`,
      String(now),
      String(tier.windowMs),
      String(tier.limit),
      // Unique member: bare timestamps collide under load and would silently dedupe.
      `${now}-${(counter = (counter + 1) % 1_000_000)}-${randomBytes(3).toString("hex")}`,
    );
    return {
      allowed: allowed === 1,
      limit: tier.limit,
      remaining: Math.max(0, tier.limit - count),
      retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
    };
  } catch (err) {
    if (FAIL_CLOSED_BUCKETS[bucket]) {
      logger.error({ err, bucket }, "rate limiter unavailable; denying security-critical request");
      return { allowed: false, limit: tier.limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(tier.windowMs / 1000)) };
    }
    logger.warn({ err, bucket }, "rate limiter unavailable; allowing request");
    return { allowed: true, limit: tier.limit, remaining: tier.limit, retryAfterSeconds: 0 };
  }
}

const applyHeaders = (res: Response, decision: RateDecision, tier: RateTier): void => {
  const windowSeconds = Math.round(tier.windowMs / 1000);
  res.setHeader("RateLimit-Policy", `${tier.limit};w=${windowSeconds}`);
  res.setHeader(
    "RateLimit",
    `limit=${tier.limit}, remaining=${decision.remaining}, reset=${decision.allowed ? windowSeconds : decision.retryAfterSeconds}`,
  );
};

/**
 * Consumes one slot or throws 429. Used directly by the app host and the Anthropic proxy, which
 * key on identities (app id, job token) the generic express guard cannot see.
 */
export async function consumeRate(res: Response, bucket: RateBucket, identity: string): Promise<void> {
  const tier: RateTier = RATE_TIERS[bucket];
  const decision = await checkRate(bucket, identity, tier);
  applyHeaders(res, decision, tier);
  if (decision.allowed) return;
  res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  throw new HttpError(429, "rate_limited", {
    retryAfterSeconds: decision.retryAfterSeconds,
    limit: tier.limit,
    windowSeconds: Math.round(tier.windowMs / 1000),
  });
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Best identity available. The guard runs before `requireAuth` (verifying a session costs a
 * network call), so an authenticated caller is identified by a hash of their bearer token — stable
 * per session and never shared across users behind one NAT.
 */
export function callerIdentity(req: Request): string {
  if (req.user) return `u:${req.user.id}`;
  const bearer = req.headers.authorization;
  if (bearer?.startsWith("Bearer ")) {
    const token = bearer.slice(7).trim();
    if (token.length > 0) return `t:${createHash("sha256").update(token).digest("base64url").slice(0, 32)}`;
  }
  const body: unknown = req.body;
  if (body !== null && typeof body === "object" && !Array.isArray(body) && "address" in body) {
    const wallet: unknown = body.address;
    if (typeof wallet === "string" && EVM_ADDRESS.test(wallet)) return `w:${wallet.toLowerCase()}`;
  }
  return `ip:${clientIp(req)}`;
}

/** Trusts exactly one proxy hop (Railway's edge); `app.set("trust proxy", 1)` makes `req.ip` the client. */
export const clientIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? "unknown";

const READ_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true };

/** Platform-API route classes, resolved from the request path. `null` means "not limited here". */
function classify(req: Request): RateBucket | null {
  const path = req.path;
  // The proxy limits per job token (see proxy/anthropic.ts); an IP bucket would lump every sandbox together.
  if (path.startsWith("/proxy/")) return null;
  if (path.startsWith("/webhooks/")) return "webhook";
  if (path.startsWith("/admin")) return "admin";
  if (path === "/rpc") return "rpc";
  if (path.startsWith("/auth/")) return "auth";
  if (READ_METHODS[req.method]) return "read";
  // Money leaving the platform and public proposal spam get their own, tighter budgets.
  if (path === "/me/withdraw" || path === "/me/claim" || path === "/pyre/claim" || /^\/bounties\/[^/]+\/claim$/.test(path)) return "payout";
  if (path === "/me/trade" || path === "/me/quote") return "trade";
  if (path === "/proposals") return "proposal";
  if (path === "/uploads/coin-image") return "upload";
  if (path === "/launches" || /^\/apps\/[^/]+\/fork$/.test(path)) return "launch";
  if (path === "/reports") return "report";
  return "write";
}

/**
 * Mounted on the `/v1` router: every platform endpoint gets a class-appropriate limit keyed by
 * caller identity, before auth or the database is touched.
 */
export const rateLimitGuard: RequestHandler = (req, res, next) => {
  const bucket = classify(req);
  if (!bucket) {
    next();
    return;
  }
  consumeRate(res, bucket, callerIdentity(req))
    .then(() => next())
    .catch(next);
};
