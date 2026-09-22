import { z } from "zod";

/** Name of the repeatable job that runs the daily growth sweep. */
export const DAILY_JOB_NAME = "growth:daily";

/** Payload for per-app growth jobs enqueued by the scheduler/build engine. */
export const GrowthJobData = z.object({
  appId: z.string(),
  kind: z.enum(["milestone", "deploy", "revive", "changelog", "reply"]),
  milestone: z.string().optional(),
  /** Pre-composed text; when present it is posted verbatim (no LLM call). */
  text: z.string().max(4000).optional(),
  version: z.number().int().optional(),
});
export type GrowthJobData = z.infer<typeof GrowthJobData>;

/** Apps below this build budget never spend on growth. */
export const MIN_GROWTH_BUDGET_MICROS = 2_000_000n;

/** Flat ops fee charged per successful X post, on top of LLM cost. */
export const POST_OPS_FEE_MICROS = 50_000n;

/** Max mention replies per app per day. */
export const MAX_REPLIES_PER_DAY = 5;

export const REPLIED_SET_TTL_SEC = 7 * 24 * 3600;
export const DAY_MS = 24 * 3600 * 1000;
