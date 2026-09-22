import { useId } from "react";
import { cx } from "./cx.js";
import { clamp01, heatColor, heatGradient, useHeatRamp, HEAT_STEPS } from "./heat.js";

export interface HeatGaugeProps {
  /** 0–1: the coin's heat index (curve progress, fee velocity, build activity). */
  value: number;
  variant?: "bar" | "arc";
  /** Bar width / arc diameter in px. */
  size?: number;
  /** Show the value as a mono readout in the current heat colour. */
  readout?: boolean;
  label?: string;
  className?: string;
}


/**
 * Heat Index. The ramp is the value axis: cold violet-black at 0, white-hot at 1.
 * Bar for cards and rows, arc for a coin page hero.
 */
export const HeatGauge = ({ value, variant = "bar", size, readout = true, label = "Heat index", className }: HeatGaugeProps) => {
  const id = useId();
  const ramp = useHeatRamp();
  const v = clamp01(value);
  const color = heatColor(v, ramp);
  // Cold values sit near the canvas colour; lift the readout so it stays legible.
  const readoutColor = heatColor(0.4 + v * 0.6, ramp);
  const text = `${Math.round(v * 100)}`;

  if (variant === "arc") {
    const d = size ?? 96;
    const sw = Math.max(4, Math.round(d * 0.08));
    const r = (d - sw) / 2;
    const c = Math.PI * r; // half circumference (a 180° arc)
    return (
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        className={cx("relative inline-flex flex-col items-center", className)}
        style={{ width: d }}
      >
        <svg width={d} height={d / 2 + sw} viewBox={`0 0 ${d} ${d / 2 + sw}`} aria-hidden>
          <defs>
            <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
              {ramp.map((stop, i) => (
                <stop key={i} offset={i / (HEAT_STEPS - 1)} stopColor={stop} />
              ))}
            </linearGradient>
          </defs>
          <path d={`M ${sw / 2} ${d / 2 + sw / 2} A ${r} ${r} 0 0 1 ${d - sw / 2} ${d / 2 + sw / 2}`} fill="none" stroke="var(--color-fill-2)" strokeWidth={sw} strokeLinecap="round" />
          <path
            d={`M ${sw / 2} ${d / 2 + sw / 2} A ${r} ${r} 0 0 1 ${d - sw / 2} ${d / 2 + sw / 2}`}
            fill="none"
            stroke={`url(#${id})`}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - v)}
            className="transition-[stroke-dashoffset] duration-(--duration-reveal) ease-(--ease-reveal)"
            style={{ filter: v > 0.8 ? `drop-shadow(0 0 ${Math.round(sw)}px ${color})` : undefined }}
          />
        </svg>
        {readout && (
          <span className="figure absolute bottom-0 text-22 transition-colors duration-(--duration-reveal)" style={{ color: readoutColor }}>
            {text}
          </span>
        )}
      </div>
    );
  }

  const w = size ?? 64;
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className={cx("inline-flex items-center gap-2", className)}
    >
      <span className="relative h-1.5 overflow-hidden rounded-pill bg-fill-2" style={{ width: w }}>
        <span
          className="absolute inset-y-0 left-0 rounded-pill transition-[width] duration-(--duration-reveal) ease-(--ease-reveal)"
          style={{ width: `${v * 100}%`, backgroundImage: heatGradient(), backgroundSize: `${w}px 100%`, boxShadow: v > 0.8 ? `0 0 8px ${color}` : undefined }}
        />
      </span>
      {readout && (
        <span className="num text-12 font-medium transition-colors duration-(--duration-reveal)" style={{ color: readoutColor }}>
          {text}
        </span>
      )}
    </span>
  );
};
