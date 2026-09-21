/**
 * Money arithmetic shared by the API, the runner and any ops script that has to
 * reproduce a number the platform already committed to. Everything here is exact
 * bigint arithmetic and free of I/O, so the same function that credits a budget
 * can be replayed against a stored row to prove nothing drifted.
 *
 * Browser-safe on purpose: the web bundle imports this package, so nothing in
 * here may reach for a Node builtin.
 */
import { FEE_SPLIT_BPS, FORK_ROYALTY_BPS, CREDITS_FUNDING_BPS, bps } from "./constants.js";
import { WEI_PER_ETH } from "./util.js";

/** `ethPriceUsd` as exact micro-dollars per ETH; rejects prices a fee sweep could never have observed. */
const priceMicros = (ethPriceUsd: number): bigint => {
  if (!Number.isFinite(ethPriceUsd) || ethPriceUsd < 0) throw new RangeError(`invalid ETH price: ${ethPriceUsd}`);
  return BigInt(Math.round(ethPriceUsd * 1e6));
};

/** USD micros for `wei` at `ethPriceUsd`, exact in bigint (price rounded to micro-dollars, result floored). */
export const usdMicrosFromWei = (wei: bigint, ethPriceUsd: number): bigint => (wei * priceMicros(ethPriceUsd)) / WEI_PER_ETH;

/** Wei needed to buy `usdMicros` worth of ETH at `ethPriceUsd` (floored). Throws on a zero price. */
export const weiFromUsdMicros = (usdMicros: bigint, ethPriceUsd: number): bigint => {
  const price = priceMicros(ethPriceUsd);
  if (price === 0n) throw new RangeError("ETH price must be positive to convert USD to wei");
  return (usdMicros * WEI_PER_ETH) / price;
};

export const formatUsdMicros = (micros: bigint): string => `$${(Number(micros) / 1e6).toFixed(2)}`;

/** Share of the launcher cut that goes to $PYRE stakers of the app, when any exist. */
export const STAKERS_OF_LAUNCHER_BPS = 2000;

export interface FeeSplit {
  usdMicros: bigint;
  buildMicros: bigint;
  creditsMicros: bigint;
  pyreMicros: bigint;
  launcherMicros: bigint;
  upstreamMicros: bigint;
  stakersMicros: bigint;
}

/**
 * Splits one creator-fee collection into its destinations. Exact in bigint: the launcher cut
 * absorbs the rounding so the parts always sum back to `usdMicros`
 * (`build + credits + ship + launcher + upstream + stakers === usdMicros`).
 *
 * The fork royalty and the credits-funding slice are both carved out of the build cut, in that
 * order, so `creditsMicros` is a share of what remains for this app after any upstream royalty.
 */
export function splitFees(usdMicros: bigint, hasParent: boolean, hasStakers: boolean): FeeSplit {
  let buildMicros = bps(usdMicros, FEE_SPLIT_BPS.BUILD_BUDGET);
  const pyreMicros = bps(usdMicros, FEE_SPLIT_BPS.PYRE_TOKEN);
  let launcherMicros = usdMicros - buildMicros - pyreMicros;
  const upstreamMicros = hasParent ? bps(buildMicros, FORK_ROYALTY_BPS) : 0n;
  buildMicros -= upstreamMicros;
  const creditsMicros = bps(buildMicros, CREDITS_FUNDING_BPS);
  buildMicros -= creditsMicros;
  const stakersMicros = hasStakers ? bps(launcherMicros, STAKERS_OF_LAUNCHER_BPS) : 0n;
  launcherMicros -= stakersMicros;
  return { usdMicros, buildMicros, creditsMicros, pyreMicros, launcherMicros, upstreamMicros, stakersMicros };
}
