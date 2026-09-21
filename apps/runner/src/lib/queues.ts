import { Queue, type Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { env } from "../env.js";

export type WorkerContext = { redis: Redis; log: Logger };

/** Every worker module registers its BullMQ workers against this context and returns them for shutdown. */
export type RegisterWorkers = (ctx: WorkerContext) => Worker[] | Promise<Worker[]>;

export const createRedis = (): Redis =>
  new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

export const QUEUE_NAMES = [
  "intake",
  "launch",
  "build",
  "buyback",
  "feeSweep",
  "monitor",
  "price",
  "holders",
  "market",
  "growth",
  "scheduler",
  "prReview",
  "reconcile",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const connection = createRedis();

export const queues: Record<QueueName, Queue> = Object.fromEntries(
  QUEUE_NAMES.map((name) => [
    name,
    new Queue(name, {
      connection,
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    }),
  ]),
) as Record<QueueName, Queue>;

export const closeQueues = async (): Promise<void> => {
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await connection.quit();
};
