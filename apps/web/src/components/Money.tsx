import { EthFlow, UsdFlow, cx } from "../ui/index.js";
import { formatEth, formatUsd, formatUsdCompact } from "../lib/format.js";

/*
 * Money in the two units the product speaks. `live` renders an odometer that
 * rolls on change (hero numbers, proof strip); static renders plain mono text
 * (tables, cards) so a list of a hundred rows does not mount a hundred
 * animation controllers.
 */

export const Usd = ({ micros, compact, live, className }: { micros: bigint | number | string; compact?: boolean; live?: boolean; className?: string }) =>
  live ? (
    <UsdFlow micros={typeof micros === "string" ? BigInt(micros) : micros} compact={compact} className={className} />
  ) : (
    <span className={cx("num", className)}>{compact ? formatUsdCompact(micros) : formatUsd(micros)}</span>
  );

export const Eth = ({ wei, digits, live, className }: { wei: bigint | number | string; digits?: number; live?: boolean; className?: string }) =>
  live ? (
    <EthFlow wei={typeof wei === "string" ? BigInt(wei) : wei} digits={digits ?? 4} className={className} />
  ) : (
    <span className={cx("num", className)}>{formatEth(wei, { digits })}</span>
  );

/** Signed percentage delta in the role colour: `+12.4%` earn, `−3.1%` burn, `—` when unknown. */
export const Delta = ({ pct, className }: { pct: number | null | undefined; className?: string }) => {
  if (pct == null || !Number.isFinite(pct)) return <span className={cx("num text-ink-3", className)}>—</span>;
  const up = pct >= 0;
  return (
    <span className={cx("num", up ? "text-earn" : "text-burn", className)}>
      {up ? "+" : "−"}
      {Math.abs(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%
    </span>
  );
};
