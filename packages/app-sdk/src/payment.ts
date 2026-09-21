/** USDG (Global Dollar) on Robinhood Chain has 6 decimals, so one USD micro is one USDG unit. */
export const USDG_DECIMALS = 6;

/** `1234567n` → `"1.234567"`, for showing a price the user is about to pay. */
export function formatUsdg(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
