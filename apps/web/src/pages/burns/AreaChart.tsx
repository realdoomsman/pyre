import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { cx } from "../../ui/index.js";

export interface AreaPoint {
  /** Unix ms. */
  t: number;
  v: number;
}

export interface AreaMarker {
  t: number;
  label: string;
}

export interface AreaChartProps {
  points: ReadonlyArray<AreaPoint>;
  /** Vertical rules with a label on hover (burns over a revenue series, say). */
  markers?: ReadonlyArray<AreaMarker>;
  tone?: "burn" | "earn" | "accent";
  height?: number;
  formatValue: (v: number) => string;
  /** Accessible summary of the series. */
  label: string;
  className?: string;
}

const STROKE: Record<NonNullable<AreaChartProps["tone"]>, string> = {
  burn: "var(--color-burn)",
  earn: "var(--color-earn)",
  accent: "var(--color-accent)",
};

const PAD = { top: 12, right: 12, bottom: 22, left: 12 } as const;

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtStamp = (ms: number): string => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * A cumulative series as an area with no gridlines: accent stroke, soft fill,
 * dashed marker rules, and a crosshair readout on hover. Scales to its box.
 */
export const AreaChart = ({ points, markers = [], tone = "burn", height = 200, formatValue, label, className }: AreaChartProps) => {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(200, entry.contentRect.width)));
    ro.observe(el);
    setWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, [points.length === 0]);

  const geo = useMemo(() => {
    if (points.length === 0) return null;
    const t0 = points[0]!.t;
    const t1 = Math.max(points[points.length - 1]!.t, t0 + 1);
    const vMax = Math.max(...points.map((p) => p.v), 1e-9);
    const w = width - PAD.left - PAD.right;
    const h = height - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * w;
    const y = (v: number) => PAD.top + (1 - v / vMax) * h;
    // Step-after: a cumulative series holds its value until the next event.
    let d = `M${x(points[0]!.t).toFixed(1)} ${y(points[0]!.v).toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      d += ` H${x(p.t).toFixed(1)} V${y(p.v).toFixed(1)}`;
    }
    const last = points[points.length - 1]!;
    d += ` H${(PAD.left + w).toFixed(1)}`;
    const area = `${d} V${(PAD.top + h).toFixed(1)} H${PAD.left.toFixed(1)} Z`;
    return { t0, t1, x, y, d, area, last, w, h };
  }, [points, width, height]);

  if (!geo) {
    return (
      <div ref={box} className={cx("grid place-items-center rounded-control border border-dashed border-line text-12 text-ink-3", className)} style={{ height }}>
        nothing to plot yet
      </div>
    );
  }

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const t = geo.t0 + ((px - PAD.left) / geo.w) * (geo.t1 - geo.t0);
    // Nearest point at or before t (step-after semantics).
    let idx = 0;
    for (let i = 0; i < points.length; i++) if (points[i]!.t <= t) idx = i;
    setHover(idx);
  };

  const hp = hover === null ? null : points[hover]!;
  const stroke = STROKE[tone];
  const ticks = [geo.t0, geo.t0 + (geo.t1 - geo.t0) / 2, geo.t1];

  return (
    <div ref={box} className={cx("relative w-full", className)}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className="block touch-none"
      >
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="1" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geo.area} fill={`url(#${id})`} />
        <path d={geo.d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {markers.map((m, i) => (
          <line key={i} x1={geo.x(m.t)} x2={geo.x(m.t)} y1={PAD.top} y2={PAD.top + geo.h} stroke="var(--color-burn)" strokeOpacity="0.45" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        ))}
        {ticks.map((t, i) => (
          <text key={i} x={geo.x(t)} y={height - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} className="fill-ink-3" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
            {fmtDate(t)}
          </text>
        ))}
        {hp && (
          <>
            <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={PAD.top} y2={PAD.top + geo.h} stroke="var(--color-line-3)" vectorEffect="non-scaling-stroke" />
            <circle cx={geo.x(hp.t)} cy={geo.y(hp.v)} r="3" fill={stroke} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      <div className="pointer-events-none absolute right-3 top-2 rounded-control border border-line-2 bg-raised px-2.5 py-1.5 text-12 leading-4 text-ink">
        <div className="num font-medium">{formatValue(hp ? hp.v : geo.last.v)}</div>
        <div className="num text-ink-3">{hp ? fmtStamp(hp.t) : "now"}</div>
      </div>
    </div>
  );
};
