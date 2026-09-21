import { useEffect, useRef, type ReactNode } from "react";
import { durationMs, easeCss, useReducedMotion } from "../lib/motion.js";
import { cx } from "./cx.js";

export interface TickFlashProps {
  /** The watched value. A change flashes the wrapper for 600ms. */
  value: number | bigint | string;
  /** `auto` picks earn for increases and burn for decreases (numeric values only). */
  tone?: "auto" | "earn" | "burn";
  as?: "span" | "div" | "td" | "tr";
  className?: string;
  children: ReactNode;
}

/**
 * Wrap a live value: when it changes, the background flashes in the role
 * colour and fades over 600ms. Never fires on mount, never idles. Runs on the
 * Web Animations API so the children (an odometer, say) are never remounted
 * and a second change mid-flash simply restarts it.
 */
export const TickFlash = ({ value, tone = "auto", as: Tag = "span", className, children }: TickFlashProps) => {
  const ref = useRef<HTMLElement>(null);
  const prev = useRef(value);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    const was = prev.current;
    prev.current = value;
    const el = ref.current;
    if (!el || reduced) return;
    let dir: "up" | "down" = tone === "burn" ? "down" : "up";
    if (tone === "auto" && typeof value !== "string" && typeof was !== "string") dir = value >= was ? "up" : "down";
    const role = dir === "up" ? "--color-earn" : "--color-burn";
    el.dataset.tick = dir;
    el.animate(
      [{ backgroundColor: `color-mix(in oklab, var(${role}) 28%, transparent)` }, { backgroundColor: "transparent" }],
      { duration: durationMs.tick, easing: easeCss.ui, fill: "forwards" },
    ).onfinish = () => delete el.dataset.tick;
  }, [value, tone, reduced]);

  return (
    <Tag ref={ref as never} className={cx("rounded-[3px]", className)}>
      {children}
    </Tag>
  );
};
