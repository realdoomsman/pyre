import { useSyncExternalStore } from "react";

/*
 * The heat ramp as data. CSS owns the colours (`--heat-0..5`, themed); this
 * reads them once per theme so SVG/JS consumers (gauges, kilns, canvases)
 * can interpolate a colour for a value in 0–1.
 */

export const HEAT_STEPS = 6;

const FALLBACK = ["#1c1b2e", "#3b2f7a", "#7a66f5", "#3e8bff", "#9cd2ff", "#e9f1ff"];

let cached: string[] | null = null;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

const readRamp = (): string[] => {
  if (typeof document === "undefined") return FALLBACK;
  const style = getComputedStyle(document.documentElement);
  const ramp = Array.from({ length: HEAT_STEPS }, (_, i) => style.getPropertyValue(`--heat-${i}`).trim() || FALLBACK[i]);
  return ramp;
};

const snapshot = (): string[] => {
  if (!cached) cached = readRamp();
  return cached;
};

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  if (!observer && typeof document !== "undefined") {
    observer = new MutationObserver(() => {
      cached = null;
      for (const l of listeners) l();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
};

/** The six current heat colours (re-reads when `data-theme` changes). */
export const useHeatRamp = (): string[] => useSyncExternalStore(subscribe, snapshot, () => FALLBACK);

const hex = (c: string): [number, number, number] => {
  const s = c.replace("#", "");
  const n = parseInt(s.length === 3 ? s.replace(/./g, (ch) => ch + ch) : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Colour for `value` in 0–1 along `ramp` (linear RGB mix between stops). */
export const heatColor = (value: number, ramp: string[] = FALLBACK): string => {
  const v = clamp01(value);
  const pos = v * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(pos));
  const t = pos - i;
  const a = hex(ramp[i]);
  const b = hex(ramp[i + 1]);
  const mix = a.map((ch, k) => Math.round(ch + (b[k] - ch) * t));
  return `rgb(${mix[0]} ${mix[1]} ${mix[2]})`;
};

/** CSS gradient through the whole ramp, for bars and arcs. */
export const heatGradient = (direction = "90deg"): string =>
  `linear-gradient(${direction}, ${Array.from({ length: HEAT_STEPS }, (_, i) => `var(--heat-${i})`).join(", ")})`;

/** Clamp to 0–1; non-finite → 0. */
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
