import { adapterFor, solanaEnabled, type VenueAdapter } from "@pyre/chain";
import type { App } from "@pyre/db";
import { VENUES, venueOf, type Chain, type Launchpad, type SolanaCluster, type VenueDto, type VenueMeta } from "@pyre/shared";
import { env } from "../env.js";
import { HttpError } from "./errors.js";

/** The columns every venue-dispatched code path needs from an app row. */
export type VenueRow = Pick<App, "chain" | "launchpad">;

/** The adapter that signs and reads for this app's venue. */
export const adapterOf = (app: VenueRow): VenueAdapter => adapterFor(app.launchpad);

/** Pure venue facts (labels, decimals, link builders) for this app. */
export const metaOf = (app: VenueRow): VenueMeta => venueOf(app);

/** Solana cluster the API runs against, for explorer links; null for EVM venues. */
export const clusterOf = (chain: Chain): SolanaCluster | null => (chain === "solana" ? env.SOLANA_CLUSTER : null);

/**
 * Whether launches are accepted on a launchpad right now. PONS v2 is closed for good: the legacy
 * Robinhood Chain coins keep trading, sweeping and building, but no new coin launches there.
 * pump.fun follows the environment kill switches (not on-chain gating).
 */
export const venueEnabled = (launchpad: Launchpad): boolean => launchpad === "pump_fun" && solanaEnabled() && env.PUMP_LAUNCH_ENABLED;

/** Refundable launch stake in native base units of `chain` (env overrides for staging). */
export const requiredStake = (chain: Chain): bigint => (chain === "robinhood" ? env.LAUNCH_STAKE_WEI : env.LAUNCH_STAKE_LAMPORTS);

/** Throws 409 when the venue is not accepting launches: a launch or stake on it cannot be served. */
export const assertVenueEnabled = (launchpad: Launchpad): void => {
  if (!venueEnabled(launchpad)) throw new HttpError(409, "venue_disabled", { launchpad });
};

export const venuesDto = (): VenueDto[] =>
  (Object.values(VENUES) as VenueMeta[]).map((v) => ({
    chain: v.chain,
    launchpad: v.launchpad,
    enabled: venueEnabled(v.launchpad),
    stakeWei: requiredStake(v.chain).toString(),
    chainLabel: v.chainLabel,
    launchpadLabel: v.launchpadLabel,
    native: v.native,
    tokenDecimals: v.tokenDecimals,
    cluster: clusterOf(v.chain),
  }));

/** Explorer links for an app's tokens/txs/addresses on its venue (cluster-aware on Solana). */
export const links = (app: VenueRow) => {
  const meta = metaOf(app);
  const cluster = clusterOf(app.chain) ?? undefined;
  return {
    tx: (hash: string) => (app.chain === "robinhood" ? `${env.BLOCKSCOUT_URL}/tx/${hash}` : meta.explorerTxUrl(hash, cluster)),
    address: (address: string) => (app.chain === "robinhood" ? `${env.BLOCKSCOUT_URL}/address/${address}` : meta.explorerAddressUrl(address, cluster)),
    token: (token: string) => (app.chain === "robinhood" ? `${env.BLOCKSCOUT_URL}/token/${token}` : meta.explorerTokenUrl(token, cluster)),
    launchpad: (token: string) => meta.launchpadUrl(token),
  };
};
