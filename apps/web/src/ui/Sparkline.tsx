import { useId } from "react";
import { cx } from "./cx.js";

export interface SparklineProps {
  data: ReadonlyArray<number>;
  width?: number;
  height?: number;
  /** `auto` = earn when the series ends above where it began, else burn. */
  tone?: "auto" | "earn" | "burn" | "accent" | "plain";
  /** Soft fill under the line. */
  area?: boolean;
  /** Mark the last point. */
  dot?: boolean;
  className?: string;
}

const STROKE: Record<Exclude<SparklineProps["tone"], "auto" | undefined>, string> = {
  earn: "var(--color-earn)",
  burn: "var(--color-burn)",
  accent: "var(--color-accent)",
  plain: "var(--color-ink-3)",
};

/** A 60px story: the shape of a series, no axes. */
export const Sparkline = ({ data, width = 60, height = 24, tone = "auto", area = true, dot, className }: SparklineProps) => {
  const id = useId();
  const n = data.length;
  if (n < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="var(--color-line-2)" strokeWidth="1" strokeDasharray="2 3" />
      </svg>
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 1.5;
  const x = (i: number) => pad + (i / (n - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const path = data.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(" ");
  const resolved = tone === "auto" ? (data[n - 1] >= data[0] ? "earn" : "burn") : tone;
  const stroke = STROKE[resolved];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx("overflow-visible", className)} aria-hidden>
      {area && (
        <>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={stroke} stopOpacity="0.22" />
              <stop offset="1" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${path} L${x(n - 1).toFixed(2)} ${height} L${x(0).toFixed(2)} ${height} Z`} fill={`url(#${id})`} />
        </>
      )}
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {dot && <circle cx={x(n - 1)} cy={y(data[n - 1])} r="2" fill={stroke} />}
    </svg>
  );
};
