import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma, type JobToken } from "@pyre/db";
import { GLOBAL_DAILY_COMPUTE_CEILING_USD, MODELS } from "@pyre/shared";
import { env } from "../env.js";
import { HttpError, wrap } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { costMicrosFor, type Usage } from "../lib/pricing.js";
import { clientIp, consumeRate } from "../lib/ratelimit.js";

const UPSTREAM = "https://api.anthropic.com";
const DAILY_CEILING_MICROS = BigInt(GLOBAL_DAILY_COMPUTE_CEILING_USD) * 1_000_000n;

/**
 * Hard ceilings. A sandbox token is held by agent-written code inside the sandbox, so it must not be
 * able to pick an arbitrary (expensive) model, ask for unbounded output, or post unbounded bytes.
 */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 32_000;

/** Exactly the models the platform routes to, plus their dated (`-YYYYMMDD`) pins. */
const ALLOWED_MODELS: Record<string, true> = {};
for (const model of Object.values(MODELS)) ALLOWED_MODELS[model] = true;

const DATED_SUFFIX = /-\d{8}$/;

function modelAllowed(model: string): boolean {
  if (ALLOWED_MODELS[model]) return true;
  const base = model.replace(DATED_SUFFIX, "");
  return base !== model && ALLOWED_MODELS[base] === true;
}

/** Request-side fields we police; everything else is forwarded verbatim as raw bytes. */
const RequestShape = z.object({
  model: z.string().min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
});

const UsageShape = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().nullable().optional(),
  cache_read_input_tokens: z.number().nullable().optional(),
});
/** Upstream `usage` object as reported on both streaming frames and non-streaming responses. */
export type UsageReport = z.infer<typeof UsageShape>;

const StreamFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_start"), message: z.object({ model: z.string().optional(), usage: UsageShape }) }),
  z.object({ type: z.literal("message_delta"), usage: UsageShape }),
]);
const NonStreamResponse = z.object({ model: z.string().optional(), usage: UsageShape });

/**
 * Headers copied from the sandbox request to Anthropic. Auth is replaced, never forwarded;
 * `anthropic-beta` is dropped (beta flags change billing and output limits) and `content-type` is
 * always set by us since the body may have been re-serialized.
 */
const FORWARD_HEADERS: Record<string, true> = {
  accept: true,
  "anthropic-version": true,
  "user-agent": true,
};
/** Upstream response headers echoed back to the sandbox. */
const ECHO_HEADERS: Record<string, true> = {
  "content-type": true,
  "request-id": true,
  "anthropic-ratelimit-requests-remaining": true,
  "anthropic-ratelimit-tokens-remaining": true,
  "retry-after": true,
};

export const applyUsage = (u: Usage, raw: UsageReport): void => {
  // Every frame reports cumulative counts; keep the latest non-null value of each.
  if (raw.input_tokens !== undefined) u.inputTokens = raw.input_tokens;
  if (raw.output_tokens !== undefined) u.outputTokens = raw.output_tokens;
  if (raw.cache_creation_input_tokens != null) u.cacheCreationInputTokens = raw.cache_creation_input_tokens;
  if (raw.cache_read_input_tokens != null) u.cacheReadInputTokens = raw.cache_read_input_tokens;
};

export interface UsageScanner {
  /** Feeds decoded SSE text; partial frames are buffered until their terminator arrives. */
  scan(text: string): void;
  /** Model reported by `message_start`, when it differs from the requested one. */
  readonly model: string | null;
}

/** Accumulates usage out of an Anthropic SSE stream without altering the bytes passed to the client. */
export function createUsageScanner(usage: Usage): UsageScanner {
  let pending = "";
  let model: string | null = null;
  return {
    get model() {
      return model;
    },
    scan(text: string) {
      pending += text;
      let idx: number;
      while ((idx = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const parsed = StreamFrame.safeParse(JSON.parse(line.slice(5).trim()));
            if (!parsed.success) continue;
            if (parsed.data.type === "message_start") {
              if (parsed.data.message.model) model = parsed.data.message.model;
              applyUsage(usage, parsed.data.message.usage);
            } else applyUsage(usage, parsed.data.usage);
          } catch {
            // non-JSON data line (e.g. ping); ignore
          }
        }
      }
    },
  };
}

/**
 * USD-micros an in-flight request may cost at most: MAX_OUTPUT_TOKENS of output plus a byte-derived
 * input estimate, priced at the requested model. Deliberately an upper bound — the usage scanner
 * trues it down on settle, so a stale read can never let concurrent requests overspend.
 */
const EST_BYTES_PER_TOKEN = 4;
const reserveEstimate = (model: string, bodyBytes: number): bigint =>
  costMicrosFor(model, {
    inputTokens: Math.ceil(bodyBytes / EST_BYTES_PER_TOKEN),
    outputTokens: MAX_OUTPUT_TOKENS,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });

/** Undo a reservation in full: the request never spent (upstream error, network failure, abort). */
const releaseReservation = async (token: string, day: string, estimate: bigint): Promise<void> => {
  await prisma
    .$transaction([
      prisma.jobToken.update({ where: { token }, data: { spentMicros: { decrement: estimate } } }),
      prisma.dailyComputeSpend.update({ where: { day }, data: { micros: { decrement: estimate } } }),
    ])
    .catch((err: unknown) => logger.error({ err }, "proxy reservation release failed"));
};

/**
 * Reconcile a settled request: swap the reserved estimate for the actual cost (the delta may be
 * negative, releasing the unused reservation) and charge the job's running total the real amount.
 */
const settleReservation = async (
  token: string,
  jobId: string,
  day: string,
  estimate: bigint,
  model: string,
  usage: Usage,
): Promise<void> => {
  const actual = costMicrosFor(model, usage);
  const delta = actual - estimate;
  await prisma.$transaction([
    prisma.jobToken.update({ where: { token }, data: { spentMicros: { increment: delta } } }),
    prisma.buildJob.updateMany({ where: { id: jobId }, data: { costMicros: { increment: actual } } }),
    prisma.dailyComputeSpend.update({ where: { day }, data: { micros: { increment: delta } } }),
  ]);
  logger.debug(
    { jobId, model, usage, actualMicros: actual.toString(), estimateMicros: estimate.toString() },
    "proxy spend reconciled",
  );
};

export interface Reservation {
  readonly day: string;
  /** Reconcile with the request's actual usage. */
  settle(model: string, usage: Usage): Promise<void>;
  /** Release the whole estimate (nothing was spent). */
  release(): Promise<void>;
}

/**
 * Optimistic reservation against BOTH the per-token budget and the global daily ceiling. Each is a
 * single conditional increment guarded by `spent + estimate <= cap`, so concurrent requests serialize
 * on the row and none can out-read a stale total to overspend. Reserved BEFORE forwarding; the caller
 * MUST settle (actual usage) or release (failure/abort) the handle exactly once.
 */
export const reserveBudget = async (jobToken: JobToken, model: string, bodyBytes: number): Promise<Reservation> => {
  const estimate = reserveEstimate(model, bodyBytes);
  const day = new Date().toISOString().slice(0, 10);

  const tokenReserved = await prisma.jobToken.updateMany({
    where: { token: jobToken.token, spentMicros: { lte: jobToken.budgetMicros - estimate } },
    data: { spentMicros: { increment: estimate } },
  });
  if (tokenReserved.count === 0) throw new HttpError(402, "budget_exhausted");

  await prisma.dailyComputeSpend.upsert({ where: { day }, create: { day, micros: 0n }, update: {} });
  const dayReserved = await prisma.dailyComputeSpend.updateMany({
    where: { day, micros: { lte: DAILY_CEILING_MICROS - estimate } },
    data: { micros: { increment: estimate } },
  });
  if (dayReserved.count === 0) {
    // Only the per-token reservation landed; the daily increment did not. Roll back the token
    // alone — a full release would also decrement the day counter, under-counting the ceiling and
    // letting a later request slip past it.
    await prisma.jobToken
      .update({ where: { token: jobToken.token }, data: { spentMicros: { decrement: estimate } } })
      .catch((err: unknown) => logger.error({ err }, "proxy token reservation rollback failed"));
    throw new HttpError(429, "daily_compute_ceiling");
  }

  return {
    day,
    settle: (finalModel, usage) => settleReservation(jobToken.token, jobToken.jobId, day, estimate, finalModel, usage),
    release: () => releaseReservation(jobToken.token, day, estimate),
  };
};

/**
 * Token validity and rate limits: a fail-closed IP throttle BEFORE the DB lookup (a flood of invalid
 * tokens must not hit findUnique unbounded), the token itself, then a per-job request rate. Budget and
 * the daily ceiling are reserved per request (see reserveBudget), not checked here, so a stale read
 * cannot let concurrent calls overspend.
 */
const authorize = async (req: Request, res: Response): Promise<JobToken> => {
  await consumeRate(res, "proxyIp", `ip:${clientIp(req)}`);
  const header = req.headers["x-api-key"];
  const bearer = req.headers.authorization;
  const token =
    (typeof header === "string" && header.length > 0 ? header : undefined) ??
    (bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : undefined);
  if (!token) throw new HttpError(401, "invalid_token");
  const jobToken = await prisma.jobToken.findUnique({ where: { token } });
  if (!jobToken || jobToken.revoked || jobToken.expiresAt.getTime() <= Date.now()) throw new HttpError(401, "invalid_token");
  await consumeRate(res, "proxy", `job:${jobToken.jobId}`);
  return jobToken;
};

/** Raw body with an explicit byte ceiling; the parser limit alone would surface as a 413 without context. */
function requestBody(req: Request): Buffer {
  const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (body.length > MAX_REQUEST_BYTES) throw new HttpError(413, "request_too_large", { maxBytes: MAX_REQUEST_BYTES });
  return body;
}

/**
 * Parses and vets the request: allowlisted model, bounded output. An over-large `max_tokens` is
 * clamped (and the body re-serialized) rather than rejected so a long build does not die on it.
 */
function vetRequest(body: Buffer): { model: string; stream: boolean; body: Buffer } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const shape = RequestShape.safeParse(parsed);
  if (!shape.success) throw new HttpError(400, "invalid_request");
  if (!modelAllowed(shape.data.model)) {
    logger.warn({ model: shape.data.model }, "proxy: model not allowlisted");
    throw new HttpError(403, "model_not_allowed", { model: shape.data.model, allowed: Object.keys(ALLOWED_MODELS) });
  }
  let out = body;
  if (shape.data.max_tokens !== undefined && shape.data.max_tokens > MAX_OUTPUT_TOKENS) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_request");
    logger.warn({ requested: shape.data.max_tokens, cap: MAX_OUTPUT_TOKENS }, "proxy: max_tokens clamped");
    out = Buffer.from(JSON.stringify({ ...parsed, max_tokens: MAX_OUTPUT_TOKENS }), "utf8");
  }
  return { model: shape.data.model, stream: shape.data.stream === true, body: out };
}

const forward = async (req: Request, path: string, body: Buffer): Promise<globalThis.Response> => {
  const headers: Record<string, string> = { "x-api-key": env.ANTHROPIC_API_KEY };
  for (const name in req.headers) {
    const value = req.headers[name];
    if (FORWARD_HEADERS[name] && typeof value === "string") headers[name] = value;
  }
  headers["content-type"] = "application/json";
  headers["anthropic-version"] ??= "2023-06-01";
  return fetch(`${UPSTREAM}${path}`, { method: "POST", headers, body, signal: AbortSignal.timeout(600_000) });
};

const echoHeaders = (upstream: globalThis.Response, res: Response): void => {
  res.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (ECHO_HEADERS[name]) res.setHeader(name, value);
  });
};

const proxyMessages = async (req: Request, res: Response): Promise<void> => {
  const jobToken = await authorize(req, res);
  const vetted = vetRequest(requestBody(req));
  let model = vetted.model;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

  // Reserve a conservative estimate up front; every exit path below settles or releases it exactly once.
  const reservation = await reserveBudget(jobToken, model, vetted.body.length);
  let settled = false;
  const release = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    await reservation.release();
  };
  const settle = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    await reservation.settle(model, usage);
  };

  let upstream: globalThis.Response;
  try {
    upstream = await forward(req, "/v1/messages", vetted.body);
  } catch (err) {
    await release(); // failed before any spend could occur — safe to release in full
    throw err;
  }
  echoHeaders(upstream, res);

  if (!upstream.ok || !upstream.body) {
    res.send(Buffer.from(await upstream.arrayBuffer()));
    await release(); // upstream refused; nothing was billed
    return;
  }

  if (!vetted.stream) {
    const text = await upstream.text();
    res.send(text);
    try {
      const parsed = NonStreamResponse.safeParse(JSON.parse(text));
      if (parsed.success) {
        if (parsed.data.model) model = parsed.data.model;
        applyUsage(usage, parsed.data.usage);
      }
    } catch (err) {
      logger.warn({ err }, "proxy: unparseable non-stream response");
    }
    await settle();
    return;
  }

  // Streaming: pipe bytes through untouched while scanning SSE frames for usage.
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const scanner = createUsageScanner(usage);
  res.on("close", () => {
    if (!res.writableFinished) reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      scanner.scan(decoder.decode(value, { stream: true }));
      if (!res.writableEnded) res.write(value);
    }
  } catch (err) {
    logger.warn({ err, jobId: jobToken.jobId }, "proxy: upstream stream interrupted");
  } finally {
    if (!res.writableEnded) res.end();
    if (scanner.model) model = scanner.model;
    // Settle with the scanned usage: an aborted stream still bills the partial output it produced and
    // releases the estimate delta. Never auto-retries, never double-spends.
    await settle();
  }
};

export const anthropicProxy = Router();
anthropicProxy.use(express.raw({ type: () => true, limit: MAX_REQUEST_BYTES }));

anthropicProxy.post("/v1/messages", wrap(proxyMessages));

/** Token counting is free upstream; still gated by the job token so only live sandboxes can call it. */
anthropicProxy.post(
  "/v1/messages/count_tokens",
  wrap(async (req, res) => {
    await authorize(req, res);
    const vetted = vetRequest(requestBody(req));
    const upstream = await forward(req, "/v1/messages/count_tokens", vetted.body);
    echoHeaders(upstream, res);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  }),
);

/** Nothing else is proxied: an unknown path must never reach Anthropic with the platform key. */
anthropicProxy.use((_req, res) => {
  res.status(404).json({ error: "unknown_proxy_path", status: 404 });
});
