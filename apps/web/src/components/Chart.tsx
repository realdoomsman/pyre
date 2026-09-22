import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import type { CandleDto } from "@pyre/shared";
import { Chip, Skeleton, cx } from "../ui/index.js";

export type ChartMode = "price" | "mcap";
export type ChartUnit = "usd" | "native";

export interface ChartMarker {
  /** Unix seconds. */
  t: number;
  kind: "deploy";
  label: string;
}

export interface ChartProps {
  /** `undefined` while loading → skeleton. Prices are USD per token, ascending time. */
  candles: CandleDto[] | undefined;
  interval: string;
  onIntervalChange?: (interval: string) => void;
  intervals?: readonly string[];
  /** Initial toggles; the toolbar owns them after mount. */
  mode?: ChartMode;
  unit?: ChartUnit;
  markers?: ReadonlyArray<ChartMarker>;
  /** The app's native asset for the USD → native toggle: its symbol and USD price. */
  native: { symbol: string; priceUsd: number };
  /** Circulating supply in whole tokens (display number) for the MCap toggle. */
  supply: number;
  height?: number;
  className?: string;
}

const DEFAULT_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

/** lightweight-charts paints a canvas, so it needs resolved colours, not `var()`. */
const readTokens = () => {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    up: read("--color-earn", "#4fd1a6"),
    down: read("--color-burn", "#ff4d6d"),
    line: read("--color-line-2", "rgba(255,255,255,.12)"),
    grid: read("--color-line", "rgba(255,255,255,.07)"),
    ink2: read("--color-ink-2", "#9b9891"),
    ink3: read("--color-ink-3", "#8a877f"),
    accent: read("--color-accent", "#9d8cff"),
    build: read("--color-build", "#3e8bff"),
    mono: read("--font-mono", "ui-monospace, monospace"),
  };
};

const withAlpha = (color: string, alpha: number): string =>
  /^#[0-9a-f]{6}$/i.test(color) ? `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}` : color;

/** Axis glyph for the native unit: Ξ for ETH, ◎ for SOL, the symbol otherwise. */
const NATIVE_GLYPH: Record<string, string> = { ETH: "Ξ", SOL: "◎" };

const fmtAxis = (mode: ChartMode, unit: ChartUnit, symbol: string) => (v: number) => {
  if (unit === "native") {
    const glyph = NATIVE_GLYPH[symbol] ?? symbol;
    return mode === "mcap" ? `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${glyph}` : `${v.toPrecision(4)} ${glyph}`;
  }
  if (mode === "mcap") return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`;
  return v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toPrecision(3)}`;
};

/**
 * Candles + volume. The toolbar toggles interval, Price/MCap and USD/native;
 * deploy markers sit above the candles. Reads colours from the
 * tokens so it follows the theme.
 */
export const Chart = ({
  candles,
  interval,
  onIntervalChange,
  intervals = DEFAULT_INTERVALS,
  mode: initialMode = "mcap",
  unit: initialUnit = "usd",
  markers = [],
  native,
  supply,
  height = 360,
  className,
}: ChartProps) => {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [mode, setMode] = useState<ChartMode>(initialMode);
  const [unit, setUnit] = useState<ChartUnit>(initialUnit);

  // Scale factor: USD price → chosen mode/unit.
  const factor = (mode === "mcap" ? supply : 1) / (unit === "native" && native.priceUsd > 0 ? native.priceUsd : 1);

  const series = useMemo(() => {
    if (!candles) return null;
    const sorted = [...candles].sort((a, b) => a.t - b.t);
    const out: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number }> = [];
    let lastT = -1;
    for (const c of sorted) {
      if (c.t === lastT) continue;
      lastT = c.t;
      out.push({ time: c.t as UTCTimestamp, open: c.o * factor, high: c.h * factor, low: c.l * factor, close: c.c * factor, volume: c.v });
    }
    return out;
  }, [candles, factor]);

  // Mount once; recreate when the host resizes via the chart's own autosize.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = readTokens();
    const api = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: t.ink3, fontFamily: t.mono, fontSize: 11 },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.line, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderColor: t.line, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: t.ink3, labelBackgroundColor: t.ink2, style: LineStyle.Dashed }, horzLine: { color: t.ink3, labelBackgroundColor: t.ink2 } },
      handleScroll: { vertTouchDrag: false },
    });
    const cs = api.addCandlestickSeries({
      upColor: t.up,
      downColor: t.down,
      borderUpColor: t.up,
      borderDownColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
      priceLineVisible: false,
    });
    const vs = api.addHistogramSeries({ priceScaleId: "volume", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
    api.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    chart.current = api;
    candleSeries.current = cs;
    volumeSeries.current = vs;
    return () => {
      api.remove();
      chart.current = null;
      candleSeries.current = null;
      volumeSeries.current = null;
    };
  }, []);

  // Data + axis format follow the toggles.
  useEffect(() => {
    const cs = candleSeries.current;
    const vs = volumeSeries.current;
    if (!cs || !vs || !series) return;
    const t = readTokens();
    const format = fmtAxis(mode, unit, native.symbol);
    cs.applyOptions({ priceFormat: { type: "custom", formatter: format, minMove: 1e-12 } });
    cs.setData(series);
    vs.setData(series.map((c) => ({ time: c.time, value: c.volume, color: withAlpha(c.close >= c.open ? t.up : t.down, 0.35) })));
    const ms: SeriesMarker<UTCTimestamp>[] = markers
      .filter((m) => m.t >= (series[0]?.time ?? 0))
      .sort((a, b) => a.t - b.t)
      .map((m) => ({ time: m.t as UTCTimestamp, position: "aboveBar", shape: "circle", color: t.build, text: m.label }));
    cs.setMarkers(ms);
    chart.current?.timeScale().fitContent();
  }, [series, markers, mode, unit, native.symbol]);

  const loading = candles === undefined;
  const empty = !loading && series !== null && series.length === 0;

  return (
    <div className={cx("overflow-hidden rounded-card border border-line bg-surface", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div role="group" aria-label="Interval" className="flex items-center gap-1">
          {intervals.map((i) => (
            <Chip key={i} size="sm" mono selected={i === interval} onClick={() => onIntervalChange?.(i)} disabled={!onIntervalChange}>
              {i}
            </Chip>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Series">
          <Chip size="sm" mono selected={mode === "mcap"} onClick={() => setMode("mcap")}>
            mcap
          </Chip>
          <Chip size="sm" mono selected={mode === "price"} onClick={() => setMode("price")}>
            price
          </Chip>
          <span className="mx-1 h-4 w-px bg-line-2" aria-hidden />
          <Chip size="sm" mono selected={unit === "usd"} onClick={() => setUnit("usd")}>
            usd
          </Chip>
          <Chip size="sm" mono selected={unit === "native"} onClick={() => setUnit("native")} disabled={!(native.priceUsd > 0)}>
            {native.symbol.toLowerCase()}
          </Chip>
        </div>
      </div>
      <div className="relative" style={{ height }}>
        <div ref={host} className={cx("absolute inset-0", (loading || empty) && "invisible")} />
        {loading && (
          <div className="absolute inset-0 grid place-items-end p-3" aria-busy>
            <Skeleton className="h-full w-full" rounded="card" />
          </div>
        )}
        {empty && (
          <p className="num absolute inset-0 grid place-items-center text-12 text-ink-3">no fills in this window yet</p>
        )}
      </div>
    </div>
  );
};
