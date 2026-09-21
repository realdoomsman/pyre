import { useSyncExternalStore } from "react";

/*
 * Motion constants, mirrored from the tokens in `index.css`. Use these when a
 * transition is driven from JS (motion/react, Web Animations, timers); use the
 * CSS custom properties when it is driven from CSS.
 */

export type Bezier = readonly [number, number, number, number];

export const ease = {
  /** Interface: hover, press, toggles. */
  ui: [0.4, 0, 0.2, 1] as Bezier,
  /** Reveals: panels, rows, skeleton → content. */
  reveal: [0.25, 1, 0.5, 1] as Bezier,
  /** Scenes: page-level entrances. */
  scene: [0.19, 1, 0.22, 1] as Bezier,
  /** Heat: white-hot cooling to accent. */
  heat: [0.16, 1, 0.3, 1] as Bezier,
} as const;

export const easeCss = {
  ui: `cubic-bezier(${ease.ui.join(",")})`,
  reveal: `cubic-bezier(${ease.reveal.join(",")})`,
  scene: `cubic-bezier(${ease.scene.join(",")})`,
  heat: `cubic-bezier(${ease.heat.join(",")})`,
} as const;

/** Durations in milliseconds. */
export const durationMs = {
  ui: 140,
  reveal: 400,
  scene: 900,
  heat: 1200,
  /** TickFlash / Proof Strip flash. */
  tick: 600,
  /** Digit roll ceiling for odometer numbers. */
  roll: 300,
  /** Robinhood Chain block cadence: confirmation ticks stream at this rate. */
  block: 100,
} as const;

/** Same durations in seconds, the unit motion/react expects. */
export const duration = {
  ui: durationMs.ui / 1000,
  reveal: durationMs.reveal / 1000,
  scene: durationMs.scene / 1000,
  heat: durationMs.heat / 1000,
  tick: durationMs.tick / 1000,
} as const;

/** Trays, sheets and anything the user drags. */
export const spring = {
  tray: { type: "spring", stiffness: 260, damping: 26 } as const,
} as const;

const QUERY = "(prefers-reduced-motion: reduce)";
const subscribe = (cb: () => void) => {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const read = () => typeof window !== "undefined" && window.matchMedia(QUERY).matches;

/** True when the user asked for reduced motion. Live-updates if the setting changes. */
export const useReducedMotion = (): boolean => useSyncExternalStore(subscribe, read, () => false);
