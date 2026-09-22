import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { GlobalFrame } from "../api/types.js";
import { formatEth, formatTokenUnits, timeAgoShort } from "../lib/format.js";
import { StatusLed, cx } from "../ui/index.js";

export interface TapeRow {
  id: string;
  at: string;
  slug: string;
  ticker: string;
  kind: "trade" | "burn" | "deploy" | "fees" | "launch" | "graduated";
  side?: "BUY" | "SELL";
  /** The figure: tabular, never truncated. */
  amount: string;
  /** Secondary note; truncates before anything else does. */
  detail?: string;
  href: string;
}

const MAX_ROWS = 40;

/** Frame → tape row, or null for build-loop chatter the tape does not carry. */
export const tapeRow = (f: GlobalFrame): TapeRow | null => {
  const e = f.event;
  if (!e) return null;
  const p = e.payload;
  const base = { id: e.id, at: e.createdAt, slug: f.slug, ticker: f.ticker, href: `/c/${f.slug}` };
  switch (p.type) {
    case "TRADE":
      return { ...base, kind: "trade", side: p.side, amount: formatEth(p.quoteWei), detail: `${formatTokenUnits(p.tokenUnits)} tokens` };
    case "DEPLOY":
      return { ...base, kind: "deploy", amount: `v${p.version}`, href: p.url };
    case "FEES":
      return { ...base, kind: "fees", amount: formatEth(p.wei) };
    case "LAUNCH":
      return { ...base, kind: "launch", amount: "on PONS" };
    case "GRADUATED":
      return { ...base, kind: "graduated", amount: "v4 pool" };
    default:
      return null;
  }
};

/** Keeps the newest `MAX_ROWS` tape rows; returns the list and a frame sink. */
export const useTape = () => {
  const [rows, setRows] = useState<TapeRow[]>([]);
  const pausedRef = useRef(false);
  const buffer = useRef<TapeRow[]>([]);
  const flush = useCallback(() => {
    if (buffer.current.length === 0) return;
    const pending = buffer.current;
    buffer.current = [];
    setRows((prev) => [...pending.reverse(), ...prev].slice(0, MAX_ROWS));
  }, []);
  const push = useCallback(
    (f: GlobalFrame) => {
      const row = tapeRow(f);
      if (!row) return;
      buffer.current.push(row);
      if (!pausedRef.current) flush();
    },
    [flush],
  );
  const setPaused = useCallback(
    (p: boolean) => {
      pausedRef.current = p;
      if (!p) flush();
    },
    [flush],
  );
  return { rows, push, setPaused, seed: setRows };
};

const KIND_LABEL: Record<TapeRow["kind"], { label: string; className: string }> = {
  trade: { label: "trade", className: "text-ink-2" },
  burn: { label: "burn", className: "text-burn" },
  deploy: { label: "deploy", className: "text-build" },
  fees: { label: "fees", className: "text-earn" },
  launch: { label: "launch", className: "text-accent" },
  graduated: { label: "grad", className: "text-accent" },
};

export interface LiveTapeProps {
  rows: ReadonlyArray<TapeRow>;
  /** SSE state, for the LED. */
  live: boolean;
  onPause?: (paused: boolean) => void;
  height?: number;
  className?: string;
}

/**
 * The right-rail tape: trades, burns, deploys as they happen. Hovering pauses
 * the stream (rows queue and land on leave) so a row cannot move under the
 * cursor.
 */
export const LiveTape = ({ rows, live, onPause, height = 360, className }: LiveTapeProps) => (
  <section
    className={cx("overflow-hidden rounded-card border border-line bg-surface", className)}
    aria-label="Live activity"
    onMouseEnter={() => onPause?.(true)}
    onMouseLeave={() => onPause?.(false)}
    onFocus={() => onPause?.(true)}
    onBlur={() => onPause?.(false)}
  >
    <header className="flex h-9 items-center gap-2 border-b border-line px-3">
      <StatusLed tone={live ? "live" : "idle"} label={live ? "live" : "connecting"} />
      <span className="ml-auto text-12 text-ink-3">hover to pause</span>
    </header>
    <ol className="m-0 list-none overflow-y-auto p-0" style={{ height }} aria-live="polite" aria-relevant="additions">
      {rows.length === 0 && <li className="num px-3 py-8 text-center text-12 text-ink-3">waiting for the next fill…</li>}
      {rows.map((r) => {
        const k = KIND_LABEL[r.kind];
        const external = r.href.startsWith("http");
        const inner = (
          <>
            <span className={cx("num w-10 shrink-0 text-12 uppercase tracking-[0.04em]", r.kind === "trade" && r.side === "SELL" ? "text-burn" : r.kind === "trade" ? "text-earn" : k.className)}>
              {r.kind === "trade" ? r.side?.toLowerCase() : k.label}
            </span>
            <span className="num min-w-[3.5rem] shrink truncate text-13 text-ink">${r.ticker}</span>
            {r.detail && <span className="num min-w-0 flex-1 truncate text-12 text-ink-3">{r.detail}</span>}
            <span className="num ml-auto shrink-0 text-13 text-ink-2">{r.amount}</span>
            <span className="num w-9 shrink-0 text-right text-12 text-ink-3">{timeAgoShort(r.at)}</span>
          </>
        );
        const cls = "flex items-center gap-2 px-3 py-1.5 transition-colors duration-(--duration-ui) hover:bg-fill animate-rise";
        return (
          <li key={r.id} className="border-b border-line last:border-0">
            {external ? (
              <a href={r.href} target="_blank" rel="noreferrer noopener" className={cls}>
                {inner}
              </a>
            ) : (
              <Link to={r.href} className={cls}>
                {inner}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  </section>
);
