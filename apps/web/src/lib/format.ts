/*
 * Formatting for the three amount units the product speaks:
 *   USD    micros  (1e6 per dollar)   bigint
 *   ETH    wei     (1e18 per ETH)     bigint
 *   tokens base units (1e18 default)  bigint
 *
 * Every function is BigInt-safe: integers are split with bigint arithmetic and
 * only the fractional tail (or a compacted mantissa) is ever a Number. Inputs
 * also accept `number` and decimal `string` so API JSON (which cannot carry
 * bigint) formats without a conversion at the call site.
 */

export type Amount = bigint | number | string;

const toBig = (v: Amount): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
  const s = v.trim();
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
};

const group = (int: bigint): string => int.toLocaleString("en-US");

/** Split `units` by `10^decimals` into a grouped integer part and a fixed-length fraction. */
const split = (units: bigint, decimals: number, wanted: number): { neg: boolean; int: string; frac: string } => {
  const digits = Math.min(wanted, decimals);
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const rem = abs % base;
  // Round the fraction to `digits`, carrying into the integer if it overflows.
  const keep = 10n ** BigInt(decimals - digits);
  let fracUnits = digits === 0 ? 0n : rem / keep;
  let intPart = int;
  if (digits > 0) {
    const roundUp = (rem % keep) * 2n >= keep;
    if (roundUp) fracUnits += 1n;
    if (fracUnits >= 10n ** BigInt(digits)) {
      fracUnits = 0n;
      intPart += 1n;
    }
  } else if ((rem * 2n) >= base) {
    intPart += 1n;
  }
  return { neg: neg && (intPart !== 0n || fracUnits !== 0n), int: group(intPart), frac: digits === 0 ? "" : fracUnits.toString().padStart(digits, "0") };
};

const fixed = (units: bigint, decimals: number, digits: number): string => {
  const { neg, int, frac } = split(units, decimals, digits);
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
};

/**
 * Compact mantissa: 1_234_567 → "1.23M". Works on the scaled integer so it is
 * precise past 2^53. Thousands only compact from 10k: "1,234" reads better
 * than "1.23k" and costs nothing in a tabular column.
 */
const compact = (units: bigint, decimals: number, digits = 2): string => {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const sign = neg ? "-" : "";
  const tiers: Array<[bigint, bigint, string]> = [
    [1_000_000_000_000n, 1_000_000_000_000n, "T"],
    [1_000_000_000n, 1_000_000_000n, "B"],
    [1_000_000n, 1_000_000n, "M"],
    [10_000n, 1_000n, "k"],
  ];
  for (const [from, size, suffix] of tiers) {
    if (whole >= from) {
      const precision = 10 ** (digits + 1);
      const scaled = Number((abs * BigInt(precision)) / (size * base)) / precision;
      return `${sign}${trimZeros(scaled.toFixed(digits))}${suffix}`;
    }
  }
  return `${sign}${fixed(abs, decimals, whole >= 100n ? 0 : digits)}`;
};

const trimZeros = (s: string): string => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

/** USD micros → "$1,234.56". Negative → "-$1.00". */
export const formatUsd = (micros: Amount, digits = 2): string => {
  const s = fixed(toBig(micros), 6, digits);
  return s.startsWith("-") ? `-$${s.slice(1)}` : `$${s}`;
};

/** USD micros → "$1.2M" / "$45.3k" / "$980" / "$0.42". */
export const formatUsdCompact = (micros: Amount): string => {
  const s = compact(toBig(micros), 6);
  return s.startsWith("-") ? `-$${s.slice(1)}` : `$${s}`;
};

/**
 * Wei → "0.0420 ETH". Precision follows magnitude so small fees stay legible
 * and treasury balances do not sprout eight decimals.
 */
export const formatEth = (wei: Amount, opts: { unit?: boolean; digits?: number } = {}): string => {
  const w = toBig(wei);
  const abs = w < 0n ? -w : w;
  const oneEth = 10n ** 18n;
  const digits = opts.digits ?? (abs >= 100n * oneEth ? 2 : abs >= oneEth ? 3 : 4);
  let s: string;
  if (abs !== 0n && abs < oneEth / 10n ** BigInt(digits)) {
    s = `${w < 0n ? "-" : ""}<0.${"0".repeat(digits - 1)}1`;
  } else {
    s = fixed(w, 18, digits);
  }
  return opts.unit === false ? s : `${s} ETH`;
};

/** Token base units → "1.00B" / "412.5M" / "1,234". */
export const formatTokenUnits = (units: Amount, opts: { decimals?: number; compact?: boolean; digits?: number } = {}): string => {
  const decimals = opts.decimals ?? 18;
  const u = toBig(units);
  return opts.compact === false ? fixed(u, decimals, opts.digits ?? 0) : compact(u, decimals, opts.digits ?? 2);
};

/** Plain counts: 1,234 / 12.4k / 1.2M. */
export const formatCount = (n: Amount): string => compact(toBig(n), 0, 1);

/** Fraction 0–1 → "12.3%". NaN/undefined → "—". */
export const formatPct = (fraction: number | null | undefined, digits = 1): string =>
  fraction == null || !Number.isFinite(fraction) ? "—" : `${trimZeros((fraction * 100).toFixed(digits))}%`;

/** Basis points → "85%" / "0.5%". */
export const formatBps = (bps: Amount): string => formatPct(Number(toBig(bps)) / 10_000, 2);

/** `0x84F8…4afA`. Keeps the 0x so an address reads as one at a glance. */
export const shortAddress = (address: string, chars = 4): string =>
  address.length > chars * 2 + 3 ? `${address.slice(0, chars + 2)}…${address.slice(-chars)}` : address;

/** Tiny per-token prices need more precision than money formatting offers. */
export const formatPriceUsd = (usd: number): string =>
  usd === 0
    ? "$0"
    : usd >= 1
      ? `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
      : usd >= 0.01
        ? `$${usd.toFixed(4)}`
        : `$${usd.toPrecision(3)}`;

const toMs = (input: string | number | Date | null | undefined): number => {
  if (input == null) return Number.NaN;
  if (input instanceof Date) return input.getTime();
  if (typeof input === "number") return input < 1e12 ? input * 1000 : input;
  return new Date(input).getTime();
};

export const timeAgo = (input: string | number | Date | null | undefined, now = Date.now()): string => {
  const t = toMs(input);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** `timeAgo` without the suffix, for tight tabular rows: "now" / "12s" / "3m" / "Sep 4". */
export const timeAgoShort = (input: string | number | Date | null | undefined, now = Date.now()): string => {
  const s = timeAgo(input, now);
  return s === "just now" ? "now" : s.endsWith(" ago") ? s.slice(0, -4) : s;
};

export const formatDate = (input: string | number | Date | null | undefined): string => {
  const t = toMs(input);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export const formatDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/* ───────── legacy — removed in Wave 3 ─────────
   Kept only so the pre-cutover pages compile until they are rewritten. */
export const formatSol = (sol: number): string =>
  sol >= 1000 ? `${(sol / 1000).toFixed(2)}k SOL` : sol >= 1 ? `${sol.toFixed(3)} SOL` : `${sol.toFixed(4)} SOL`;
export const formatNum = (n: number): string => formatCount(Math.round(n));
export const formatPrice = formatPriceUsd;
export const shortAddr = (a: string, n = 4) => (a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);
export const formatRatio = (r: number | null): string =>
  r === null || !Number.isFinite(r) ? "—" : r >= 1000 ? `${(r / 1000).toFixed(1)}k×` : `${r.toFixed(r >= 100 ? 0 : 1)}×`;
