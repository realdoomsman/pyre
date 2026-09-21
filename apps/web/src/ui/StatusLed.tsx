import { cx } from "./cx.js";

export type LedTone = "live" | "build" | "idle" | "warn" | "error" | "off";

const TONE: Record<LedTone, string> = {
  live: "text-earn",
  build: "text-build",
  idle: "text-ink-3",
  warn: "text-warn",
  error: "text-danger",
  off: "text-line-3",
};

const DEFAULT_LABEL: Record<LedTone, string> = {
  live: "Live",
  build: "Building",
  idle: "Idle",
  warn: "Needs attention",
  error: "Error",
  off: "Off",
};

/** A 6px status dot. `live` and `build` breathe; nothing else moves. */
export const StatusLed = ({ tone, label, className }: { tone: LedTone; label?: string; className?: string }) => (
  <span className={cx("inline-flex items-center gap-2", TONE[tone], className)} role="status" aria-label={label ?? DEFAULT_LABEL[tone]}>
    <span
      className={cx("inline-block h-1.5 w-1.5 rounded-pill bg-current", (tone === "live" || tone === "build") && "animate-pulse-dot")}
      aria-hidden
    />
    {label && <span className="eyebrow text-current">{label}</span>}
  </span>
);
