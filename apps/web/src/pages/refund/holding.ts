import type { RefundHolderDto } from "@pyre/shared";
import type { ChipTone } from "../../ui/index.js";

/** Whether a snapshot holder still holds what they had: the refund scales with the lowest balance since the snapshot. */
export type Holding = "holding" | "reduced" | "soldOut";

export const holdingOf = (h: RefundHolderDto): Holding => {
  if (h.stillHolding) return "holding";
  if (BigInt(h.minBalanceUnits) === 0n || (BigInt(h.owedWei) > 0n && BigInt(h.eligibleWei) === 0n)) return "soldOut";
  return "reduced";
};

export const HOLDING_CHIP: Record<Holding, { tone: ChipTone; label: string }> = {
  holding: { tone: "earn", label: "Still holding" },
  reduced: { tone: "warn", label: "Sold after snapshot — refund reduced" },
  soldOut: { tone: "neutral", label: "Sold out — not eligible" },
};

/** The rule as published (contract Addendum A), sentence-cased for the page. */
export const HOLD_RULE = "you must still hold the PYRE you had at the snapshot. Selling or moving it after the snapshot shrinks your refund for good; buying more doesn't raise it.";

/** part / whole as a 0–1 fraction, from decimal strings, without losing precision on large values. Clamped to 1. */
export const fraction = (part: string, whole: string): number => {
  const w = BigInt(whole);
  if (w === 0n) return 0;
  const f = Number((BigInt(part) * 1_000_000n) / w) / 1_000_000;
  return f > 1 ? 1 : f;
};
