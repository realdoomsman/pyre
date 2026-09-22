import NumberFlowBase, { type Format } from "@number-flow/react";
import { durationMs, easeCss } from "../lib/motion.js";
import { cx } from "./cx.js";

export interface NumberFlowProps {
  /** Numbers roll digit-by-digit; bigints are narrowed to a Number for display. */
  value: number | bigint;
  format?: Format;
  prefix?: string;
  suffix?: string;
  /** Force a roll direction: 1 up, -1 down, 0 none. Default follows the delta. */
  trend?: 1 | -1 | 0;
  className?: string;
}

const TIMING = { duration: durationMs.roll, easing: easeCss.reveal };
const OPACITY = { duration: durationMs.ui, easing: easeCss.ui };

/**
 * Odometer number in tabular mono. Rolls in ≤300ms with no bounce; honours
 * reduced-motion (the value simply swaps).
 */
export const NumberFlow = ({ value, format, prefix, suffix, trend, className }: NumberFlowProps) => (
  <NumberFlowBase
    value={typeof value === "bigint" ? Number(value) : value}
    format={format}
    prefix={prefix}
    suffix={suffix}
    trend={trend}
    transformTiming={TIMING}
    spinTiming={TIMING}
    opacityTiming={OPACITY}
    respectMotionPreference
    willChange
    className={cx("num", className)}
  />
);

/** USD from micros, two decimals, as an odometer. */
export const UsdFlow = ({ micros, className, compact }: { micros: bigint | number; className?: string; compact?: boolean }) => (
  <NumberFlow
    value={Number(micros) / 1e6}
    format={compact ? { notation: "compact", maximumFractionDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }}
    prefix="$"
    className={className}
  />
);

/** Native base units (wei / lamports) as an odometer with the asset's symbol. */
export const NativeFlow = ({ units, native, digits = 4, className }: { units: bigint | number; native: { symbol: string; decimals: number }; digits?: number; className?: string }) => (
  <NumberFlow value={Number(units) / 10 ** native.decimals} format={{ minimumFractionDigits: digits, maximumFractionDigits: digits }} suffix={` ${native.symbol}`} className={className} />
);

/** ETH from wei as an odometer — Robinhood-only amounts (PYRE burns, treasury). */
export const EthFlow = ({ wei, digits = 4, className }: { wei: bigint | number; digits?: number; className?: string }) => (
  <NativeFlow units={wei} native={{ symbol: "ETH", decimals: 18 }} digits={digits} className={className} />
);
