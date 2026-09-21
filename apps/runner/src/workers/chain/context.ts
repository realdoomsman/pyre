import type { Redis } from "ioredis";
import type { Logger } from "pino";

export interface ChainWorkerContext {
  redis: Redis;
  log: Logger;
}

/** Queue names this module owns workers for (contract: exact BullMQ queue names). */
export const CHAIN_QUEUES = {
  launch: "launch",
  feeSweep: "feeSweep",
  buyback: "buyback",
  price: "price",
  holders: "holders",
  market: "market",
} as const;
