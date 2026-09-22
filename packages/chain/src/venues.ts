import { ponsAdapter, PONS_INFO } from "./pons/adapter.js";
import { pumpAdapter, PUMP_INFO } from "./pump/adapter.js";
import { solanaEnabled } from "./solana/connection.js";
import type { Launchpad, VenueAdapter, VenueInfo } from "./venue.js";

/** Pure venue facts (labels, decimals, URL builders) per launchpad; no network. */
export const VENUE_INFO: Record<Launchpad, VenueInfo> = { pons_v2: PONS_INFO, pump_fun: PUMP_INFO };

const ADAPTERS: Record<Launchpad, VenueAdapter> = { pons_v2: ponsAdapter, pump_fun: pumpAdapter };

/**
 * The adapter for a launchpad. Always returns one — key derivation and address checks work
 * without an RPC — and network methods of a disabled venue throw `SolanaDisabledError`.
 */
export function adapterFor(launchpad: Launchpad): VenueAdapter {
  const adapter = ADAPTERS[launchpad];
  if (!adapter) throw new Error(`unknown launchpad: ${launchpad as string}`);
  return adapter;
}

/** Whether a venue can be used for network operations right now (env-configured). */
export function venueEnabled(launchpad: Launchpad): boolean {
  return launchpad === "pump_fun" ? solanaEnabled() : true;
}
