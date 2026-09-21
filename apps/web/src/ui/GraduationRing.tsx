import { useId, type ReactNode } from "react";
import { cx } from "./cx.js";
import { clamp01, useHeatRamp } from "./heat.js";

export interface GraduationRingProps {
  /** Bonding-curve progress 0–1 (ETH raised / 4.2 ETH). */
  progress: number;
  /** Graduated into the v4 pool: ring closes in `earn`. */
  graduated?: boolean;
  size?: number;
  /** Ring thickness. */
  stroke?: number;
  /** Usually an `Avatar` one step smaller than `size`. */
  children?: ReactNode;
  className?: string;
}

/**
 * Avatar ring that fills with the heat ramp as a coin climbs its curve and
 * seals in `earn` once it graduates.
 */
export const GraduationRing = ({ progress, graduated, size = 48, stroke = 2.5, children, className }: GraduationRingProps) => {
  const id = useId();
  const ramp = useHeatRamp();
  const p = graduated ? 1 : clamp01(progress);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className={cx("relative inline-grid place-items-center", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={graduated ? "Graduated" : `Curve ${Math.round(p * 100)}% to graduation`}
    >
      <svg className="absolute inset-0 -rotate-90" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <defs>
          <linearGradient id={id} x1="0" x2="1" y1="0" y2="1">
            {ramp.slice(1, 5).map((stop, i) => (
              <stop key={i} offset={i / 3} stopColor={stop} />
            ))}
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={graduated ? "var(--color-earn)" : `url(#${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          className="transition-[stroke-dashoffset,stroke] duration-(--duration-reveal) ease-(--ease-reveal)"
          style={graduated ? { filter: "drop-shadow(0 0 4px color-mix(in oklab, var(--color-earn) 60%, transparent))" } : undefined}
        />
      </svg>
      <span className="relative" style={{ width: size - stroke * 2 - 4, height: size - stroke * 2 - 4 }}>
        {children}
      </span>
    </span>
  );
};
