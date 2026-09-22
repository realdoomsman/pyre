/**
 * Money arithmetic shared by the API, the runner and any ops script that has to
 * reproduce a number the platform already committed to. Everything here is exact
 * bigint arithmetic and free of I/O, so the same function that credits a budget
 * can be replayed against a stored row to prove nothing drifted.
 *
 * Browser-safe on purpose: the web bundle imports this package, so nothing in
 * here may reach for a Node builtin.
 */
import { FORK_ROYALTY_BPS, CREDITS_FUNDING_BPS, bps } from "./constants.js";
import { WEI_PER_ETH } from "./util.js";
import { FEE_SPLIT_BPS_BY_CHAIN, type Chain } from "./venues.js";

/** `priceUsd` as exact micro-dollars per whole native unit; rejects prices a fee sweep could never have observed. */
const priceMicros = (priceUsd: number): bigint => {
  if (!Number.isFinite(priceUsd) || priceUsd < 0) throw new RangeError(`invalid native price: ${priceUsd}`);
  return BigInt(Math.round(priceUsd * 1e6));
};

/** USD micros for `units` of a `decimals`-place native asset at `priceUsd`, exact in bigint (price rounded to micro-dollars, result floored). */
export const usdMicrosFromNative = (units: bigint, priceUsd: number, decimals: number): bigint =>
  (units * priceMicros(priceUsd)) / 10n ** BigInt(decimals);

/** Native base units needed to buy `usdMicros` worth at `priceUsd` (floored). Throws on a zero price. */
export const nativeFromUsdMicros = (usdMicros: bigint, priceUsd: number, decimals: number): bigint => {
  const price = priceMicros(priceUsd);
  if (price === 0n) throw new RangeError("native price must be positive to convert USD to base units");
  return (usdMicros * 10n ** BigInt(decimals)) / price;
};

/** USD micros for `wei` at `ethPriceUsd`, exact in bigint (price rounded to micro-dollars, result floored). */
export const usdMicrosFromWei = (wei: bigint, ethPriceUsd: number): bigint => (wei * priceMicros(ethPriceUsd)) / WEI_PER_ETH;

/** Wei needed to buy `usdMicros` worth of ETH at `ethPriceUsd` (floored). Throws on a zero price. */
export const weiFromUsdMicros = (usdMicros: bigint, ethPriceUsd: number): bigint => nativeFromUsdMicros(usdMicros, ethPriceUsd, 18);

export const formatUsdMicros = (micros: bigint): string => `$${(Number(micros) / 1e6).toFixed(2)}`;

/** Share of the launcher cut that goes to $PYRE stakers of the app, when any exist. */
export const STAKERS_OF_LAUNCHER_BPS = 2000;

export interface FeeSplit {
  usdMicros: bigint;
  buildMicros: bigint;
  creditsMicros: bigint;
  pyreMicros: bigint;
  /** The 25% leg off Robinhood Chain: buys and burns the coin itself instead of PYRE. */
  coinBurnMicros: bigint;
  launcherMicros: bigint;
  upstreamMicros: bigint;
  stakersMicros: bigint;
}

/**
 * Splits one creator-fee collection into its destinations. Exact in bigint: the launcher cut
 * absorbs the rounding so the parts always sum back to `usdMicros`
 * (`build + credits + pyre + coinBurn + launcher + upstream + stakers === usdMicros`).
 *
 * The 25% burn leg is PYRE on Robinhood Chain and the coin itself elsewhere (`FEE_SPLIT_BPS_BY_CHAIN`).
 * The fork royalty and the credits-funding slice are both carved out of the build cut, in that
 * order, so `creditsMicros` is a share of what remains for this app after any upstream royalty.
 */
export function splitFees(usdMicros: bigint, hasParent: boolean, hasStakers: boolean, chain: Chain = "robinhood"): FeeSplit {
  const table = FEE_SPLIT_BPS_BY_CHAIN[chain];
  let buildMicros = bps(usdMicros, table.BUILD_BUDGET);
  const pyreMicros = bps(usdMicros, table.PYRE_TOKEN);
  const coinBurnMicros = bps(usdMicros, table.COIN_BURN);
  let launcherMicros = usdMicros - buildMicros - pyreMicros - coinBurnMicros;
  const upstreamMicros = hasParent ? bps(buildMicros, FORK_ROYALTY_BPS) : 0n;
  buildMicros -= upstreamMicros;
  const creditsMicros = bps(buildMicros, CREDITS_FUNDING_BPS);
  buildMicros -= creditsMicros;
  const stakersMicros = hasStakers ? bps(launcherMicros, STAKERS_OF_LAUNCHER_BPS) : 0n;
  launcherMicros -= stakersMicros;
  return { usdMicros, buildMicros, creditsMicros, pyreMicros, coinBurnMicros, launcherMicros, upstreamMicros, stakersMicros };
}
