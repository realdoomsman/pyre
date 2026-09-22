import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type ChipTone = "neutral" | "violet" | "heat";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** `neutral` for labels, `violet` for the active/selected state, `heat` for live or hot signals. */
  tone?: ChipTone;
}

const TONE: Record<ChipTone, string> = {
  neutral: "border-border bg-surface text-ink-muted",
  violet: "border-violet/40 bg-violet-soft text-violet",
  heat: "border-heat-4/40 bg-heat-1 text-heat-5",
};

/** Small mono label: a status, a count, a tag. Never a button. */
export function Chip({ tone = "neutral", className, ...rest }: ChipProps) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center gap-1 rounded-md border px-2 font-mono text-xs tabular-nums",
        TONE[tone],
        className,
      )}
      {...rest}
    />
  );
}
