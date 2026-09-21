import pino from "pino";
import { env } from "../env.js";

export const log = pino({
  name: "runner",
  level: env.LOG_LEVEL,
  base: { service: "runner" },
});
