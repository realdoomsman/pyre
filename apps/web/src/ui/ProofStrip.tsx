import { useEffect, useRef, useState } from "react";
import type { Format } from "@number-flow/react";
import { NumberFlow } from "./NumberFlow.js";
import { cx } from "./cx.js";
import { useIsMobile } from "./useMediaQuery.js";

export interface ProofItem {
  id: string;
  label: string;
  /** Rolls as an odometer. Pre-scale (e.g. wei → ETH) before passing. */
  value: number | bigint;
  format?: Format;
  prefix?: string;
  suffix?: string;
}

const ROTATE_MS = 4000;

const Counter = ({ item, compact }: { item: ProofItem; compact: boolean }) => {
  const prev = useRef(item.value);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (Object.is(prev.current, item.value)) return;
    prev.current = item.value;
    setFlash((n) => n + 1);
  }, [item.value]);
  return (
    <div className="relative flex min-w-0 shrink-0 items-baseline gap-2 px-3 py-1.5 first:pl-0 last:pr-0">
      <span className={cx("eyebrow shrink-0", compact && "sr-only md:not-sr-only")}>{item.label}</span>
      <NumberFlow value={item.value} format={item.format} prefix={item.prefix} suffix={item.suffix} className="text-13 font-medium text-ink" />
      {flash > 0 && <span key={flash} aria-hidden className="absolute inset-x-3 bottom-0 h-px bg-accent animate-proof-flash first:left-0 last:right-0" />}
    </div>
  );
};

/** One counter at a time, advancing every few seconds; the label swaps with it. */
const Rotating = ({ items }: { items: ReadonlyArray<ProofItem> }) => {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (items.length < 2) return;
    const t = setInterval(() => setI((n) => n + 1), ROTATE_MS);
    return () => clearInterval(t);
  }, [items.length]);
  const item = items[i % items.length];
  if (!item) return null;
  return (
    <div className="relative flex min-w-0 items-baseline gap-2 py-1.5">
      <span key={item.id} className="eyebrow truncate animate-fade-in">
        {item.label}
      </span>
      <NumberFlow key={item.id} value={item.value} format={item.format} prefix={item.prefix} suffix={item.suffix} className="shrink-0 text-13 font-medium text-ink" />
    </div>
  );
};

/**
 * Nav-level mono ticker of live network numbers. Each counter rolls on change
 * and underlines itself with a 1px accent rule that fades over 600ms. Below
 * `md` there is no room for three, so one shows at a time and rotates.
 */
export const ProofStrip = ({ items, compact = false, className }: { items: ReadonlyArray<ProofItem>; compact?: boolean; className?: string }) => {
  const mobile = useIsMobile();
  return (
    <div className={cx("flex min-w-0 max-w-full items-center whitespace-nowrap", !mobile && "divide-x divide-line", className)} aria-live="polite" aria-atomic={false}>
      {mobile ? (
        <Rotating items={items} />
      ) : (
        items.map((item) => <Counter key={item.id} item={item} compact={compact} />)
      )}
    </div>
  );
};
