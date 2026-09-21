import { cx } from "./cx.js";

export type ProgressTone = "accent" | "build" | "earn" | "burn" | "warn" | "heat";

const FILL: Record<ProgressTone, string> = {
  accent: "bg-accent",
  build: "bg-build",
  earn: "bg-earn",
  burn: "bg-burn",
  warn: "bg-warn",
  heat: "bg-[linear-gradient(90deg,var(--heat-1),var(--heat-2),var(--heat-3),var(--heat-4))]",
};

export interface ProgressProps {
  /** 0–1. Ignored when `indeterminate`. */
  value: number;
  tone?: ProgressTone;
  size?: "xs" | "sm" | "md";
  indeterminate?: boolean;
  label?: string;
  className?: string;
}

export const Progress = ({ value, tone = "accent", size = "sm", indeterminate, label, className }: ProgressProps) => {
  const pct = Math.min(100, Math.max(0, (Number.isFinite(value) ? value : 0) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      className={cx("relative w-full overflow-hidden rounded-pill bg-fill-2", size === "xs" ? "h-0.5" : size === "sm" ? "h-1" : "h-2", className)}
    >
      <div
        className={cx(
          "h-full rounded-pill transition-[width] duration-(--duration-reveal) ease-(--ease-reveal)",
          FILL[tone],
          indeterminate && "absolute inset-y-0 w-1/3 animate-progress-slide",
        )}
        style={indeterminate ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
};
