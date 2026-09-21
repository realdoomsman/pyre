import pino from "pino";
import { env } from "../env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "api" },
  redact: ["req.headers.authorization", "req.headers['x-api-key']", "req.headers.cookie"],
});
