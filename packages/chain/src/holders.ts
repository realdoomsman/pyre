import { setTimeout as sleep } from "node:timers/promises";
import { getAddress, type Address } from "viem";
import { z } from "zod";
import { publicClient, ROBINHOOD_CHAIN_ID } from "./chain.js";
import { blockscoutUrl, optionalEnv } from "./env.js";
import { tokenAbi } from "./pons/abi.js";
import { DEAD_ADDRESS, ponsAddresses } from "./pons/addresses.js";
import { readLaunch } from "./pons/read.js";

export type HolderSystemTag = "curve" | "locker" | "dead" | "pool-manager" | "buyback-vault";

export interface Holder {
  address: Address;
  units: bigint;
  /** Fraction of `totalSupply` (0–1). */
  share: number;
  /** Protocol-owned rows (liquidity, locked supply, burn sink); null for real holders. */
  system: HolderSystemTag | null;
}

const HoldersPage = z.object({
  items: z.array(z.object({ address: z.object({ hash: z.string() }), value: z.string() })),
  next_page_params: z.record(z.unknown()).nullable(),
});

/** The public explorer sits behind a Cloudflare challenge that rejects bare Node fetches; look like a browser. */
const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
};
const RETRIES = 3;
const PAGE_SIZE = 50;

export interface BlockscoutEndpoint {
  base: string;
  headers: Record<string, string>;
  /** Query parameters every request must carry (the PRO `apikey`). */
  query: Record<string, string>;
}

/**
 * Blockscout REST v2 base for this chain. With `BLOCKSCOUT_API_KEY` requests go through the PRO
 * gateway (`api.blockscout.com/<chainId>/api/v2?apikey=`, same schema, no WAF); otherwise the
 * public instance. https://docs.blockscout.com/devs/pro-api-responses-and-routes
 */
export function blockscoutApiBase(): BlockscoutEndpoint {
  const apiKey = optionalEnv("BLOCKSCOUT_API_KEY");
  if (apiKey) return { base: `https://api.blockscout.com/${ROBINHOOD_CHAIN_ID}/api/v2`, headers: BROWSER_HEADERS, query: { apikey: apiKey } };
  return { base: `${blockscoutUrl()}/api/v2`, headers: BROWSER_HEADERS, query: {} };
}

export class BlockscoutNotFoundError extends Error {
  constructor(path: string) {
    super(`blockscout 404 ${path}`);
    this.name = "BlockscoutNotFoundError";
  }
}

/** GET + zod parse against the Blockscout REST v2 base, retrying transient failures with backoff. */
export async function blockscoutGet<T>(path: string, schema: z.ZodType<T>, query: Record<string, string> = {}): Promise<T> {
  const endpoint = blockscoutApiBase();
  const url = new URL(`${endpoint.base}${path}`);
  for (const [k, v] of Object.entries({ ...endpoint.query, ...query })) url.searchParams.set(k, v);
  const { headers } = endpoint;
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** attempt);
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) throw new BlockscoutNotFoundError(path);
      if (!res.ok) throw new Error(`blockscout ${res.status} ${path}`);
      return schema.parse(await res.json());
    } catch (err) {
      if (err instanceof BlockscoutNotFoundError) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Top holders by balance (Blockscout `GET /tokens/{token}/holders`, keyset-paginated). Rows for the
 * launch's curve, the launch locker, the buyback vault, the v4 PoolManager and the dead address
 * are tagged `system` so a UI can show them apart from real holders.
 */
export async function getHolders(token: Address, limit = 100): Promise<Holder[]> {
  const address = getAddress(token);
  const client = publicClient();
  const [launch, totalSupply] = await Promise.all([
    readLaunch(address, client),
    client.readContract({ address, abi: tokenAbi, functionName: "totalSupply" }),
  ]);
  const { locker, poolManager, buybackVault } = ponsAddresses();
  const tags: Record<string, HolderSystemTag> = {
    [DEAD_ADDRESS.toLowerCase()]: "dead",
    [locker.toLowerCase()]: "locker",
    [poolManager.toLowerCase()]: "pool-manager",
    [buybackVault.toLowerCase()]: "buyback-vault",
  };
  if (launch.exists) tags[launch.curve.toLowerCase()] = "curve";

  const holders: Holder[] = [];
  let next: Record<string, unknown> | null = null;
  while (holders.length < limit) {
    const query: Record<string, string> = {};
    if (next) for (const [k, v] of Object.entries(next)) query[k] = String(v);
    const page = await blockscoutGet(`/tokens/${address}/holders`, HoldersPage, query);
    for (const item of page.items) {
      const units = BigInt(item.value);
      if (units <= 0n) continue;
      const holder = getAddress(item.address.hash);
      holders.push({ address: holder, units, share: totalSupply > 0n ? Number(units) / Number(totalSupply) : 0, system: tags[holder.toLowerCase()] ?? null });
      if (holders.length >= limit) break;
    }
    if (!page.next_page_params || page.items.length < PAGE_SIZE) break;
    next = page.next_page_params;
  }
  return holders;
}
