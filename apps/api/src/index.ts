import { prisma } from "@pyre/db";
import { app } from "./app.js";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { closeQueues } from "./lib/queues.js";
import { closeRedis } from "./lib/redis.js";

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, webOrigin: env.WEB_ORIGIN, appDomain: env.APP_DOMAIN ?? null }, "api listening");
});
// SSE and proxy streams are long-lived; never let Node reap them as idle.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  server.close(() => {
    Promise.all([closeQueues(), closeRedis(), prisma.$disconnect()])
      .catch((err) => logger.error({ err }, "shutdown error"))
      .finally(() => process.exit(0));
  });
  server.closeAllConnections();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));
