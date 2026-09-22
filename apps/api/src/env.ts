import { getAddress } from "viem";
import { z } from "zod";
import { LAUNCH_STAKE_BY_CHAIN, LAUNCH_STAKE_WEI, ROBINHOOD_CHAIN_ID } from "@pyre/shared";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((a) => getAddress(a));

const optionalAddress = optional.pipe(address.optional());

/** Native base units as a decimal string; empty means "use the shared default". */
const optionalUnits = optional.pipe(
  z
    .string()
    .regex(/^\d+$/)
    .transform((v) => BigInt(v))
    .optional(),
);

const optionalBool = optional.pipe(z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1").optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WEB_ORIGIN: z.string().url(),
  API_ORIGIN: z.string().url(),
  APP_DOMAIN: optional,
  INTERNAL_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  // Robinhood Chain (Arbitrum Nitro, chain id 4663). `@pyre/chain` reads RPC_URL/USDG_ADDRESS/
  // BLOCKSCOUT_URL itself; they are validated here so a misconfigured deploy fails at boot.
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().default(ROBINHOOD_CHAIN_ID),
  PLATFORM_MASTER_SEED_HEX: z.string().regex(/^(0x)?[0-9a-fA-F]{32,128}$/),
  PYRE_TOKEN: optionalAddress,
  USDG_ADDRESS: address.default("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  LAUNCH_STAKE_WEI: optionalUnits.transform((v) => v ?? LAUNCH_STAKE_WEI),
  // Solana (pump.fun venue). `@pyre/chain` reads SOLANA_RPC_URL/SOLANA_CLUSTER itself; the venue is
  // disabled (hidden from /v1/venues, launches refused) while SOLANA_RPC_URL is unset.
  SOLANA_RPC_URL: optional.pipe(z.string().url().optional()),
  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet"]).default("mainnet-beta"),
  PUMP_LAUNCH_ENABLED: optionalBool.transform((v) => v ?? true),
  LAUNCH_STAKE_LAMPORTS: optionalUnits.transform((v) => v ?? LAUNCH_STAKE_BY_CHAIN.solana),
  BLOCKSCOUT_URL: z.string().url().default("https://robinhoodchain.blockscout.com"),
  GITHUB_WEBHOOK_SECRET: optional,
  ANTHROPIC_API_KEY: z.string().min(1),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid environment: ${issues}`);
}
if (parsed.data.CHAIN_ID !== ROBINHOOD_CHAIN_ID) {
  throw new Error(`Invalid environment: CHAIN_ID must be ${ROBINHOOD_CHAIN_ID} (Robinhood Chain), got ${parsed.data.CHAIN_ID}`);
}

export const env = parsed.data;
export type Env = typeof env;
