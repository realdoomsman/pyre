import { EvmAddress, MODELS } from "@pyre/shared";
import { z } from "zod";

const empty = (s: unknown) => (typeof s === "string" && s.trim() === "" ? undefined : s);
const optional = z.preprocess(empty, z.string().optional());
const optionalUrl = z.preprocess(empty, z.string().url().optional());
const optionalAddress = z.preprocess(empty, EvmAddress.optional());

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WEB_ORIGIN: z.string().url(),
  API_ORIGIN: z.string().url(),
  APP_DOMAIN: optional,
  INTERNAL_SECRET: z.string().min(1),
  SESSION_SECRET: optional,

  /** Robinhood Chain JSON-RPC; `@pyre/chain` falls back to the public endpoint when unset. */
  RPC_URL: optionalUrl,
  /** BIP-32 master seed (16–64 bytes hex): treasury = user 0, app wallets on branch 1'. */
  PLATFORM_MASTER_SEED_HEX: z.string().regex(/^(0x)?[0-9a-fA-F]{32,128}$/, "expected 16–64 bytes of hex"),
  /** $PYRE launch token; unset until the treasury launches it (Wave 4). */
  PYRE_TOKEN: optionalAddress,
  USDG_ADDRESS: optionalAddress,
  BLOCKSCOUT_URL: optionalUrl,
  BLOCKSCOUT_API_KEY: optional,
  /** Card-funding deposit address for model credits; unset keeps credits accruing in the ledger. */
  CREDITS_FUNDING_WALLET: optionalAddress,

  ANTHROPIC_API_KEY: z.string().min(1),
  E2B_API_KEY: z.string().min(1),
  E2B_TEMPLATE: optional,
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  MODEL_ROUTINE: optional,
  MODEL_ARCHITECT: optional,
  MODEL_REVIEWER: optional,
  MODEL_INTAKE: optional,
  MODEL_CLASSIFIER: optional,
  MODEL_GROWTH: optional,

  X_API_KEY: optional,
  X_API_SECRET: optional,
  X_ACCESS_TOKEN: optional,
  X_ACCESS_SECRET: optional,
});

export type Env = z.infer<typeof Env>;

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid runner environment: ${issues}`);
}

export const env: Env = parsed.data;

/** Prebaked E2B template (`scripts/build-e2b-template.ts`); the stock image bootstraps everything from scratch. */
export const E2B_TEMPLATE_DEFAULT = "pyre-builder";

/** Model routing with env overrides. */
export const models = {
  ROUTINE: env.MODEL_ROUTINE ?? MODELS.ROUTINE,
  ARCHITECT: env.MODEL_ARCHITECT ?? MODELS.ARCHITECT,
  REVIEWER: env.MODEL_REVIEWER ?? MODELS.REVIEWER,
  INTAKE: env.MODEL_INTAKE ?? MODELS.INTAKE,
  CLASSIFIER: env.MODEL_CLASSIFIER ?? MODELS.CLASSIFIER,
  GROWTH: env.MODEL_GROWTH ?? MODELS.GROWTH,
} as const;

/** Public URL of a live app: wildcard subdomain when APP_DOMAIN is set, else API path routing. */
export const appLiveUrl = (slug: string): string =>
  env.APP_DOMAIN ? `https://${slug}.${env.APP_DOMAIN}` : `${env.API_ORIGIN}/a/${slug}`;
