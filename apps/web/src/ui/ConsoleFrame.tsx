import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StatusLed, type LedTone } from "./StatusLed.js";
import { cx } from "./cx.js";

export type ConsoleKind = "read" | "edit" | "search" | "think" | "deploy" | "error" | "info";

export interface ConsoleRow {
  id: string;
  /** Unix ms or ISO. */
  at: number | string;
  kind: ConsoleKind;
  text: string;
}

export interface ConsoleFrameProps {
  title: ReactNode;
  /** Mono session/coin id shown in the header. */
  session?: string;
  status: "live" | "idle" | "done" | "error";
  rows: ReadonlyArray<ConsoleRow>;
  /** Scroll viewport height. */
  height?: number;
  /** Pinned milestone chips or a preview slot above the rows. */
  toolbar?: ReactNode;
  className?: string;
}

const KIND_COLOR: Record<ConsoleKind, string> = {
  read: "text-tool-read",
  edit: "text-tool-edit",
  search: "text-tool-search",
  think: "text-tool-think",
  deploy: "text-build",
  error: "text-danger",
  info: "text-ink-2",
};

const STATUS_LED: Record<ConsoleFrameProps["status"], { tone: LedTone; label: string }> = {
  live: { tone: "build", label: "Live" },
  idle: { tone: "idle", label: "Idle" },
  done: { tone: "live", label: "Done" },
  error: { tone: "error", label: "Error" },
};

const stamp = (at: number | string): string => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

/**
 * The build log. A terminal frame on `mono-bg` with a hairline header (title,
 * session id, status LED) and rows colour-coded by tool. Follows the tail
 * until the reader scrolls up, then offers a "jump to live" pill.
 */
export const ConsoleFrame = ({ title, session, status, rows, height = 320, toolbar, className }: ConsoleFrameProps) => {
  const viewport = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(rows.length);

  const jump = useCallback(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollowing(true);
    setUnseen(0);
  }, []);

  useEffect(() => {
    const added = rows.length - lastCount.current;
    lastCount.current = rows.length;
    if (following) {
      const el = viewport.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else if (added > 0) {
      setUnseen((n) => n + added);
    }
  }, [rows, following]);

  const onScroll = () => {
    const el = viewport.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (atBottom !== following) {
      setFollowing(atBottom);
      if (atBottom) setUnseen(0);
    }
  };

  const led = STATUS_LED[status];
  return (
    <section className={cx("relative overflow-hidden rounded-card border border-line bg-mono-bg", className)} aria-label="Build log">
      <header className="flex h-9 items-center gap-3 border-b border-line px-3">
        <StatusLed tone={led.tone} label={led.label} />
        <span className="min-w-0 truncate text-13 font-medium text-ink">{title}</span>
        {session && <span className="num ml-auto shrink-0 text-12 text-ink-3">{session}</span>}
      </header>
      {toolbar && <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">{toolbar}</div>}
      <div ref={viewport} onScroll={onScroll} className="overflow-y-auto px-3 py-2" style={{ height }} role="log" aria-live="polite" aria-relevant="additions">
        {rows.length === 0 && <p className="num py-8 text-center text-12 text-ink-3">Waiting for the agent…</p>}
        <ol className="num m-0 list-none space-y-0.5 p-0 text-12 leading-5">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[auto_6ch_1fr] gap-x-3">
              <span className="text-ink-3">{stamp(r.at)}</span>
              <span className={cx("uppercase tracking-[0.04em]", KIND_COLOR[r.kind])}>{r.kind}</span>
              <span className={cx("whitespace-pre-wrap break-words", r.kind === "error" ? "text-danger" : "text-ink-2")}>{r.text}</span>
            </li>
          ))}
          {status === "live" && (
            <li className="grid grid-cols-[auto_6ch_1fr] gap-x-3" aria-hidden>
              <span />
              <span />
              <span className="animate-blink text-build">▍</span>
            </li>
          )}
        </ol>
      </div>
      {!following && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 left-1/2 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-pill border border-line-2 bg-raised px-3 text-12 font-medium text-ink transition-colors duration-(--duration-ui) ease-(--ease-ui) hover:border-line-3 animate-rise"
        >
          <span className="h-1.5 w-1.5 rounded-pill bg-build" aria-hidden />
          Jump to live{unseen > 0 && <span className="num text-ink-3">+{unseen}</span>}
        </button>
      )}
    </section>
  );
};
