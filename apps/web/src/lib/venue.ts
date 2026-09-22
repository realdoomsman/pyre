import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { VENUES, venueOf, type Chain, type Launchpad, type SolanaCluster, type VenueMeta, type VenuesDto } from "@pyre/shared";
import { api } from "../api/client.js";
import { explorerAddress, explorerToken, explorerTx } from "../env.js";

/*
 * Venue = chain + launchpad. The registry in `@pyre/shared` knows labels, decimals and URL
 * shapes; the API's `/v1/venues` says which venues are enabled and, on Solana, which cluster the
 * explorer links must point at. Everything on a page that renders an amount, a hash or a
 * launchpad link for an app reads it through here.
 */

export interface VenueRef {
  chain: Chain;
  launchpad: Launchpad;
}

/** URL builders bound to one venue (and, on Solana, the cluster the API reports). */
export interface VenueLinks {
  meta: VenueMeta;
  tx: (hash: string) => string;
  address: (address: string) => string;
  token: (token: string) => string;
}

const bind = (meta: VenueMeta, cluster: SolanaCluster | undefined): VenueLinks => ({
  meta,
  tx: (hash) => meta.explorerTxUrl(hash, cluster),
  address: (address) => meta.explorerAddressUrl(address, cluster),
  token: (token) => meta.explorerTokenUrl(token, cluster),
});

/** Robinhood Chain links: PYRE, the treasury, launcher payouts — everything that never leaves it. Honours `VITE_EXPLORER_URL`. */
export const ROBINHOOD: VenueLinks = { meta: VENUES.pons_v2, tx: explorerTx, address: explorerAddress, token: explorerToken };

export const venuesKey = ["venues"] as const;

/** `GET /v1/venues` — which venues accept launches right now, with the stake each asks for. */
export const useVenues = () =>
  useQuery({
    queryKey: venuesKey,
    queryFn: ({ signal }) => api.get<VenuesDto>("/v1/venues", signal),
    staleTime: 5 * 60_000,
    select: (d) => d.venues,
  });

/** Links for one app's venue. Solana links carry the cluster once `/v1/venues` has answered; until then they point at mainnet. */
export const useVenueLinks = (app: VenueRef): VenueLinks => {
  const venues = useVenues();
  const cluster = venues.data?.find((v) => v.launchpad === app.launchpad)?.cluster ?? undefined;
  return useMemo(() => (app.launchpad === "pons_v2" ? ROBINHOOD : bind(venueOf(app), cluster)), [app.chain, app.launchpad, cluster]);
};

/** Base58 Solana public key (32–44 chars, no 0/O/I/l). */
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Base58 Solana transaction signature (64 bytes → 87–88 chars). */
export const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
