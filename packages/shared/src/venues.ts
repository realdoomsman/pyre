/**
 * Launch venues: a chain + launchpad pair. This registry is the pure, browser-safe half of the
 * venue model (labels, decimals, link builders); the network half lives behind `VenueAdapter`
 * in `@pyre/chain`. Every `…Wei` column and DTO field means native base units of the app's
 * chain — wei on Robinhood Chain, lamports on Solana — and `native.decimals` says which.
 *
 * PYRE itself lives on Robinhood Chain only; a venue never changes that.
 */
import { z } from "zod";
import { FEE_SPLIT_BPS, LAUNCH_STAKE_WEI, PONS_TOTAL_SUPPLY, TOKEN_DECIMALS } from "./constants.js";
import { EXPLORER_URL, PONS_URL } from "./util.js";

export const Chain = z.enum(["robinhood", "solana"]);
export type Chain = z.infer<typeof Chain>;

export const Launchpad = z.enum(["pons_v2", "pump_fun"]);
export type Launchpad = z.infer<typeof Launchpad>;

export const NativeAsset = z.object({ symbol: z.enum(["ETH", "SOL"]), decimals: z.union([z.literal(18), z.literal(9)]) });
export type NativeAsset = z.infer<typeof NativeAsset>;

/** Solana cluster; only changes explorer links (`?cluster=devnet`). Ignored by EVM venues. */
export type SolanaCluster = "mainnet-beta" | "devnet";

export interface VenueMeta {
  chain: Chain;
  launchpad: Launchpad;
  native: NativeAsset;
  /** Coin decimals on this launchpad (PONS 18, pump 6). */
  tokenDecimals: number;
  /** Fixed supply both launchpads mint: 1B whole coins, in base units. */
  totalSupplyUnits: bigint;
  chainLabel: string;
  launchpadLabel: string;
  explorerTxUrl(tx: string, cluster?: SolanaCluster): string;
  explorerAddressUrl(address: string, cluster?: SolanaCluster): string;
  explorerTokenUrl(token: string, cluster?: SolanaCluster): string;
  /** The launchpad's own coin page. */
  launchpadUrl(token: string): string;
}

export const SOLSCAN_URL = "https://solscan.io";
export const PUMP_URL = "https://pump.fun";

const solscan = (path: string, cluster?: SolanaCluster): string =>
  `${SOLSCAN_URL}/${path}${cluster && cluster !== "mainnet-beta" ? `?cluster=${cluster}` : ""}`;

/** Both venues mint 1B whole coins; pump coins carry 6 decimals. */
export const PUMP_TOKEN_DECIMALS = 6;
export const PUMP_TOTAL_SUPPLY = 1_000_000_000n * 10n ** BigInt(PUMP_TOKEN_DECIMALS);

export const VENUES: Record<Launchpad, VenueMeta> = {
  pons_v2: {
    chain: "robinhood",
    launchpad: "pons_v2",
    native: { symbol: "ETH", decimals: 18 },
    tokenDecimals: TOKEN_DECIMALS,
    totalSupplyUnits: PONS_TOTAL_SUPPLY,
    chainLabel: "Robinhood Chain",
    launchpadLabel: "pons v2",
    explorerTxUrl: (tx) => `${EXPLORER_URL}/tx/${tx}`,
    explorerAddressUrl: (address) => `${EXPLORER_URL}/address/${address}`,
    explorerTokenUrl: (token) => `${EXPLORER_URL}/token/${token}`,
    launchpadUrl: (token) => `${PONS_URL}/launchpad/${token}`,
  },
  pump_fun: {
    chain: "solana",
    launchpad: "pump_fun",
    native: { symbol: "SOL", decimals: 9 },
    tokenDecimals: PUMP_TOKEN_DECIMALS,
    totalSupplyUnits: PUMP_TOTAL_SUPPLY,
    chainLabel: "Solana",
    launchpadLabel: "pump.fun",
    explorerTxUrl: (tx, cluster) => solscan(`tx/${tx}`, cluster),
    explorerAddressUrl: (address, cluster) => solscan(`account/${address}`, cluster),
    explorerTokenUrl: (token, cluster) => solscan(`token/${token}`, cluster),
    launchpadUrl: (token) => `${PUMP_URL}/coin/${token}`,
  },
};

/** The venue an app launched on. `chain` is carried for the row's self-consistency check. */
export const venueOf = (app: { chain: Chain; launchpad: Launchpad }): VenueMeta => {
  const meta = VENUES[app.launchpad];
  if (meta.chain !== app.chain) throw new Error(`venue mismatch: ${app.launchpad} is not on ${app.chain}`);
  return meta;
};

/** Refundable launch stake in native base units: 0.05 ETH on Robinhood Chain, 1 SOL on Solana. */
export const LAUNCH_STAKE_BY_CHAIN: Record<Chain, bigint> = {
  robinhood: LAUNCH_STAKE_WEI,
  solana: 1_000_000_000n,
};

/**
 * Creator-fee split per chain (bps, each row sums to 10_000). The 25% leg buys and burns PYRE
 * on Robinhood Chain; off Robinhood Chain there is no PYRE to buy, so the same 25% buys and
 * burns the coin itself (`COINBURN:<appId>` ledger). Build budget and launcher cuts are the
 * same everywhere.
 */
export const FEE_SPLIT_BPS_BY_CHAIN: Record<Chain, { BUILD_BUDGET: number; PYRE_TOKEN: number; COIN_BURN: number; LAUNCHER: number }> = {
  robinhood: { ...FEE_SPLIT_BPS, COIN_BURN: 0 },
  solana: { BUILD_BUDGET: 6000, PYRE_TOKEN: 0, COIN_BURN: 2500, LAUNCHER: 1500 },
};

/** Display-precision whole units for `units` at `decimals` (never feed back into money math). */
export const unitsToNumber = (units: bigint | number | string, decimals: number): number => Number(BigInt(units)) / 10 ** decimals;

/** `"1.2345 SOL"` / `"0.05 ETH"` — grouped, at most `maxFractionDigits` decimals, no trailing zeros. */
export const formatNative = (units: bigint | number | string, native: NativeAsset, maxFractionDigits = 4): string =>
  `${unitsToNumber(units, native.decimals).toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits })} ${native.symbol}`;
