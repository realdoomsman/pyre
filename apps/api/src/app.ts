import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { prisma } from "@pyre/db";
import { env } from "./env.js";
import { hostMiddleware } from "./host/index.js";
import { errorHandler } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { requestMetrics } from "./lib/metrics.js";
import { rateLimitGuard } from "./lib/ratelimit.js";
import { redis } from "./lib/redis.js";
import { v1 } from "./routes/index.js";
import { metrics } from "./routes/metrics.js";

declare module "node:http" {
  interface IncomingMessage {
    /** Raw request bytes captured by the JSON parser; needed for webhook HMAC checks. */
    rawBody?: Buffer;
  }
}

export const app = express();

app.set("trust proxy", 1);
app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
app.disable("x-powered-by");

// Host (src/host) sets its own strict CSP per app; platform API has none.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin: env.WEB_ORIGIN,
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type", "Last-Event-ID"],
    exposedHeaders: ["RateLimit", "RateLimit-Policy"],
  }),
);
app.use(compression());
app.use(
  express.json({
    limit: "2mb",
    // Only platform JSON routes: the Anthropic proxy consumes raw bytes and the app host parses its own bodies.
    type: (req) =>
      (req.url ?? "").startsWith("/v1/") &&
      !(req.url ?? "").startsWith("/v1/proxy/") &&
      /^application\/([a-z0-9.+-]+\+)?json/i.test(req.headers["content-type"] ?? ""),
    // GitHub webhook signature is computed over the raw body.
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/health" },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
  }),
);
app.use(requestMetrics);
app.use("/metrics", metrics);
app.use(hostMiddleware);
// Every /v1 endpoint is rate limited by route class before it reaches auth or the database.
app.use("/v1", rateLimitGuard, v1);

app.get("/health", (_req, res) => {
  Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()])
    .then(() => res.json({ ok: true }))
    .catch((err: unknown) => {
      logger.error({ err }, "health check failed");
      res.status(503).json({ ok: false });
    });
});

app.use((_req, res) => {
  res.status(404).json({ error: "not_found", status: 404 });
});
app.use(errorHandler);
