import { monitorEventLoopDelay } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "@pyre/db";
import { env } from "../env.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";

/* ───────────────────────────── exposition primitives ───────────────────────────── */

type Labels = Record<string, string>;

interface Collector {
  render: (out: string[]) => void;
}

const registry: Collector[] = [];

const ESCAPES: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n" };

const renderLabels = (labels: Labels): string => {
  const parts: string[] = [];
  for (const name of Object.keys(labels).sort()) {
    parts.push(`${name}="${labels[name]!.replace(/[\\"\n]/g, (c) => ESCAPES[c]!)}"`);
  }
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
};

/** Series identity: label values in sorted-name order. Cardinality is bounded by callers. */
const seriesKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((n) => `${n}\u0000${labels[n]!}`)
    .join("\u0001");

class Counter implements Collector {
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {
    registry.push(this);
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = seriesKey(labels);
    const hit = this.series.get(key);
    if (hit) hit.value += by;
    else this.series.set(key, { labels, value: by });
  }

  render(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`);
    for (const s of this.series.values()) out.push(`${this.name}${renderLabels(s.labels)} ${s.value}`);
  }
}

class Gauge implements Collector {
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {
    registry.push(this);
  }

  set(labels: Labels, value: number): void {
    this.series.set(seriesKey(labels), { labels, value });
  }

  add(labels: Labels, delta: number): void {
    const key = seriesKey(labels);
    const hit = this.series.get(key);
    if (hit) hit.value += delta;
    else this.series.set(key, { labels, value: delta });
  }

  render(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`);
    for (const s of this.series.values()) out.push(`${this.name}${renderLabels(s.labels)} ${s.value}`);
  }
}

class Histogram implements Collector {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly buckets: number[],
  ) {
    registry.push(this);
  }

  /** `value` is in seconds; Prometheus convention for duration histograms. */
  observe(labels: Labels, value: number): void {
    const key = seriesKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) s.counts[i]! += 1;
    }
  }

  render(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`);
    for (const s of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += s.counts[i]!;
        out.push(`${this.name}_bucket${renderLabels({ ...s.labels, le: String(this.buckets[i]!) })} ${cumulative}`);
      }
      out.push(`${this.name}_bucket${renderLabels({ ...s.labels, le: "+Inf" })} ${s.count}`);
      out.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      out.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
  }
}

/* ───────────────────────────────── metric instances ───────────────────────────────── */

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const DB_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const httpRequests = new Counter("pyre_http_requests_total", "HTTP requests by route template, method and status");
const httpDuration = new Histogram(
  "pyre_http_request_duration_seconds",
  "HTTP request duration by route template and method",
  HTTP_BUCKETS,
);
const dbQueries = new Counter("pyre_db_queries_total", "Prisma operations by model and operation");
const dbDuration = new Histogram("pyre_db_query_duration_seconds", "Prisma operation duration", DB_BUCKETS);

export const cacheEvents = new Counter(
  "pyre_cache_events_total",
  "Two-tier read cache events (hit_local, hit_redis, miss, single_flight, invalidate, error)",
);
export const cacheLocalEntries = new Gauge("pyre_cache_local_entries", "Entries held in the in-process LRU");
export const sseConnections = new Gauge("pyre_sse_connections", "Open server-sent-event streams by stream kind");

const queueDepth = new Gauge("pyre_queue_depth", "BullMQ queue depth by queue and state");
const processGauge = new Gauge("pyre_process", "Process resource gauges (unit label carries the dimension)");
const eventLoopLag = new Gauge("pyre_nodejs_eventloop_lag_seconds", "Event-loop delay observed since the last scrape");

/* ─────────────────────────────── http request timing ─────────────────────────────── */

const SLOW_REQUEST_MS = 1_000;
const APP_HOST_SUFFIX = env.APP_DOMAIN ? `.${env.APP_DOMAIN}` : null;

/**
 * Route template, never the raw URL: `/v1/apps/:slug`, not `/v1/apps/inboxzero`.
 * Unmatched and app-host traffic collapse into fixed labels so cardinality stays bounded.
 */
const routeTemplate = (req: Request): string => {
  const route = req.route as { path?: string | string[] } | undefined;
  if (route?.path !== undefined) {
    const raw = Array.isArray(route.path) ? (route.path[0] ?? "") : route.path;
    const path = raw === "/" ? "" : raw;
    return `${req.baseUrl}${path}` || "/";
  }
  if (req.path.startsWith("/a/")) return "/a/*";
  if (APP_HOST_SUFFIX !== null && req.hostname.endsWith(APP_HOST_SUFFIX)) return "app_host";
  return "unmatched";
};

export const requestMetrics = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = process.hrtime.bigint();
  let recorded = false;
  const record = (): void => {
    if (recorded) return;
    recorded = true;
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const route = routeTemplate(req);
    const method = req.method;
    httpRequests.inc({ route, method, status: String(res.statusCode) });
    httpDuration.observe({ route, method }, seconds);
    if (seconds * 1_000 > SLOW_REQUEST_MS) {
      logger.warn({ route, method, status: res.statusCode, durationMs: Math.round(seconds * 1_000) }, "slow request");
    }
  };
  res.on("finish", record);
  res.on("close", record);
  next();
};

/* ────────────────────────────── prisma query timing ────────────────────────────── */

const SLOW_QUERY_MS = 300;
/** One slow-query warning per shape per window; a hot slow query must not flood the log. */
const SLOW_QUERY_WINDOW_MS = 60_000;
const slowQueryLoggedAt: Record<string, number> = {};

const SHAPE_MAX_DEPTH = 4;
const SHAPE_MAX_KEYS = 24;

/** Structure of a Prisma argument tree with every value replaced by its type: shapes, never values. */
const argShape = (value: unknown, depth = 0): unknown => {
  if (value === null) return "null";
  if (Array.isArray(value)) return depth >= SHAPE_MAX_DEPTH ? "array" : [value.length > 0 ? argShape(value[0], depth + 1) : "empty"];
  switch (typeof value) {
    case "object": {
      if (value instanceof Date) return "date";
      if (depth >= SHAPE_MAX_DEPTH) return "object";
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).slice(0, SHAPE_MAX_KEYS)) {
        out[key] = argShape((value as Record<string, unknown>)[key], depth + 1);
      }
      return out;
    }
    case "bigint":
      return "bigint";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "undefined";
  }
};

const recordQuery = (model: string, operation: string, ms: number, args: unknown): void => {
  dbQueries.inc({ model, operation });
  dbDuration.observe({ model, operation }, ms / 1_000);
  if (ms < SLOW_QUERY_MS) return;
  const shape = argShape(args);
  const key = `${model}.${operation}:${JSON.stringify(shape)}`;
  const now = Date.now();
  if ((slowQueryLoggedAt[key] ?? 0) + SLOW_QUERY_WINDOW_MS > now) return;
  slowQueryLoggedAt[key] = now;
  logger.warn({ model, operation, durationMs: Math.round(ms), shape }, "slow database query");
};

/**
 * Instrumented view of the shared Prisma client: same connection pool and behaviour,
 * plus per-operation duration metrics and slow-query logging. Read paths use `db`;
 * the unextended `prisma` export keeps working everywhere else.
 */
export const db = prisma.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      const startedAt = process.hrtime.bigint();
      try {
        return await query(args);
      } finally {
        recordQuery(model ?? "raw", operation, Number(process.hrtime.bigint() - startedAt) / 1e6, args);
      }
    },
  },
});

/* ──────────────────────────────── scrape-time collection ──────────────────────────────── */

/** Mirrors `apps/runner/src/lib/queues.ts`; the runner owns the workers, the API only reads depth. */
const QUEUE_NAMES = [
  "intake",
  "launch",
  "build",
  "buyback",
  "feeSweep",
  "monitor",
  "price",
  "holders",
  "growth",
  "scheduler",
  "prReview",
] as const;

/** BullMQ key layout: pending states are lists, scheduled/terminal states are sorted sets. */
const QUEUE_STATES: Record<string, "llen" | "zcard"> = {
  wait: "llen",
  active: "llen",
  paused: "llen",
  prioritized: "zcard",
  delayed: "zcard",
  failed: "zcard",
};

/**
 * The shared client keeps an unbounded offline queue (BullMQ needs that), so a scrape must
 * impose its own deadline: an unreachable Redis reports zero depth, it never hangs /metrics.
 */
const QUEUE_SCRAPE_DEADLINE_MS = 1_000;

const collectQueueDepth = async (): Promise<void> => {
  const pipeline = redis.pipeline();
  const states = Object.entries(QUEUE_STATES);
  for (const queue of QUEUE_NAMES) {
    for (const [state, command] of states) {
      if (command === "llen") pipeline.llen(`bull:${queue}:${state}`);
      else pipeline.zcard(`bull:${queue}:${state}`);
    }
  }
  let timer: NodeJS.Timeout | undefined;
  const results = await Promise.race([
    pipeline.exec(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("queue depth deadline exceeded")), QUEUE_SCRAPE_DEADLINE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!results) return;
  let i = 0;
  for (const queue of QUEUE_NAMES) {
    for (const [state] of states) {
      const row = results[i++];
      const value = row && !row[0] && typeof row[1] === "number" ? row[1] : 0;
      queueDepth.set({ queue, state }, value);
    }
  }
};

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const START_TIME_SECONDS = Date.now() / 1_000 - process.uptime();

const collectProcess = (): void => {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  processGauge.set({ unit: "resident_memory_bytes" }, mem.rss);
  processGauge.set({ unit: "heap_used_bytes" }, mem.heapUsed);
  processGauge.set({ unit: "heap_total_bytes" }, mem.heapTotal);
  processGauge.set({ unit: "external_bytes" }, mem.external);
  processGauge.set({ unit: "cpu_seconds_total" }, (cpu.user + cpu.system) / 1e6);
  processGauge.set({ unit: "uptime_seconds" }, process.uptime());
  processGauge.set({ unit: "start_time_seconds" }, START_TIME_SECONDS);
  eventLoopLag.set({ quantile: "mean" }, loopDelay.mean / 1e9);
  eventLoopLag.set({ quantile: "0.99" }, loopDelay.percentile(99) / 1e9);
  eventLoopLag.set({ quantile: "max" }, loopDelay.max / 1e9);
  // Window resets per scrape so lag reflects the interval between scrapes, not process lifetime.
  loopDelay.reset();
};

/** Prometheus text exposition (v0.0.4) for every registered collector. */
export const renderMetrics = async (): Promise<string> => {
  try {
    await collectQueueDepth();
  } catch (err) {
    logger.warn({ err }, "queue depth scrape failed");
  }
  collectProcess();
  const out: string[] = [];
  for (const collector of registry) collector.render(out);
  out.push("");
  return out.join("\n");
};
