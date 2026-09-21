import { Queue } from "bullmq";
import type { BuildJobData } from "@pyre/shared";
import { redis } from "./redis.js";

const opts = { connection: redis, defaultJobOptions: { removeOnComplete: 500, removeOnFail: 1000 } };

export const queues = {
  intake: new Queue<{ appId: string }>("intake", opts),
  launch: new Queue<{ appId: string }>("launch", opts),
  build: new Queue<BuildJobData>("build", opts),
  prReview: new Queue<{ appId: string; prNumber: number }>("prReview", opts),
  scheduler: new Queue<{ appId: string; kind: string }>("scheduler", opts),
};

export const closeQueues = async (): Promise<void> => {
  await Promise.all(Object.values(queues).map((q) => q.close()));
};
