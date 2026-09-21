import { useEffect, useRef, useState } from "react";
import type { Format } from "@number-flow/react";
import { NumberFlow } from "./NumberFlow.js";
import { cx } from "./cx.js";

export interface ProofItem {
  id: string;
  label: string;
  /** Rolls as an odometer. Pre-scale (e.g. wei → ETH) before passing. */
  value: number | bigint;
  format?: Format;
  prefix?: string;
  suffix?: string;
}

const Counter = ({ item, compact }: { item: ProofItem; compact: boolean }) => {
  const prev = useRef(item.value);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (Object.is(prev.current, item.value)) return;
    prev.current = item.value;
    setFlash((n) => n + 1);
  }, [item.value]);
  return (
    <div className="relative flex shrink-0 items-baseline gap-2 px-3 py-1.5 first:pl-0 last:pr-0">
      <span className={cx("eyebrow shrink-0", compact && "sr-only md:not-sr-only")}>{item.label}</span>
      <NumberFlow value={item.value} format={item.format} prefix={item.prefix} suffix={item.suffix} className="text-13 font-medium text-ink" />
      {flash > 0 && <span key={flash} aria-hidden className="absolute inset-x-3 bottom-0 h-px bg-accent animate-proof-flash first:left-0 last:right-0" />}
    </div>
  );
};

/**
 * Nav-level mono ticker of live network numbers. Each counter rolls on change
 * and underlines itself with a 1px accent rule that fades over 600ms.
 */
export const ProofStrip = ({ items, compact = false, className }: { items: ReadonlyArray<ProofItem>; compact?: boolean; className?: string }) => (
  <div
    className={cx("flex max-w-full items-center divide-x divide-line overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
    aria-live="polite"
    aria-atomic={false}
  >
    {items.map((item) => (
      <Counter key={item.id} item={item} compact={compact} />
    ))}
  </div>
);
