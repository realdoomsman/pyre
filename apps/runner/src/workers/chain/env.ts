import { EvmAddress } from "@pyre/shared";
import { z } from "zod";

/**
 * The subset of the runner environment the on-chain workers need, parsed lazily so the worker
 * modules can be imported (and unit-tested) without the whole runner env. RPC / PONS / explorer
 * endpoints are read by `@pyre/chain` itself.
 */
const ChainWorkerEnv = z.object({
  API_ORIGIN: z.string().url(),
  WEB_ORIGIN: z.string().url().optional(),
  APP_DOMAIN: z.string().optional(),
  PLATFORM_MASTER_SEED_HEX: z.string().regex(/^(0x)?[0-9a-fA-F]{32,128}$/),
  /** $PYRE launch token; when set, its 25% share of every coin's creator fees is bought back and burned. */
  PYRE_TOKEN: EvmAddress.optional(),
  /** Zentro session (cookies + CardHub localStorage) for card top-ups; unset keeps credits accruing in the ledger. */
  ZENTRO_STATE: z.string().optional(),
  /** Blockscout PRO key: with it holders come from the explorer; without it the runner indexes Transfer logs itself. */
  BLOCKSCOUT_API_KEY: z.string().optional(),
});
export type ChainWorkerEnv = z.infer<typeof ChainWorkerEnv>;

let parsed: ChainWorkerEnv | undefined;

/** Parsed once on first use; empty strings from `.env` templates count as unset. */
export function chainWorkerEnv(): ChainWorkerEnv {
  if (!parsed) {
    const raw: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) raw[k] = v && v.length > 0 ? v : undefined;
    parsed = ChainWorkerEnv.parse(raw);
  }
  return parsed;
}
