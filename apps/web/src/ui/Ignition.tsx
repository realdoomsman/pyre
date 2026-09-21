import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { duration, ease, useReducedMotion } from "../lib/motion.js";
import { Address } from "./Address.js";
import { Button } from "./Button.js";
import { cx } from "./cx.js";
import { useFocusTrap } from "./useFocusTrap.js";

export interface IgnitionTick {
  id: string;
  /** e.g. "block 12,341,002" */
  label: string;
  /** e.g. "confirmed", "indexed", "curve funded" */
  detail?: string;
  tone?: "ink" | "earn" | "build";
}

export interface IgnitionProps {
  open: boolean;
  ticker: string;
  name?: string;
  txHash: string;
  explorerUrl: string;
  /** Confirmation ticks as they arrive — one per block at ~100ms. */
  ticks: ReadonlyArray<IgnitionTick>;
  /** Flip to `confirmed` when the launch tx is final; the headline changes. */
  status?: "pending" | "confirmed";
  /** Primary action after ignition (e.g. "Open coin page"). */
  action?: ReactNode;
  onClose?: () => void;
}

/**
 * Ignition. The launch confirmation: the ticker renders white-hot and cools
 * through the heat ramp to the accent over 1.2s while confirmation ticks
 * stream in at the chain's block cadence. No flame drawn — the heat is the
 * type itself.
 */
export const Ignition = ({ open, ticker, name, txHash, explorerUrl, ticks, status = "pending", action, onClose }: IgnitionProps) => {
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLOListElement>(null);
  useFocusTrap(panel, open, onClose);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ticks.length]);

  const symbol = ticker.startsWith("$") ? ticker : `$${ticker}`;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={`${symbol} ignited`}
          tabIndex={-1}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: duration.reveal, ease: ease.reveal }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-canvas px-6 text-center outline-none"
        >
          {/* A faint heat wash rising from the floor: the kiln's glow, not a flame. */}
          <div
            aria-hidden
            className={cx("pointer-events-none absolute inset-x-0 bottom-0 h-1/2", !reduced && "animate-fade-in")}
            style={{ background: "radial-gradient(60% 70% at 50% 100%, color-mix(in oklab, var(--color-accent) 14%, transparent), transparent 70%)" }}
          />
          <div className="relative flex w-full max-w-md flex-col items-center gap-6">
            <div className="eyebrow">{status === "confirmed" ? "Ignited on Robinhood Chain" : "Igniting on Robinhood Chain"}</div>
            <h1
              key={status}
              className={cx("display text-64 sm:text-88", reduced ? "text-accent" : "animate-cool-text")}
              style={{ animationDuration: "1.2s" }}
            >
              {symbol}
            </h1>
            {name && <p className="-mt-3 text-15 text-ink-2">{name}</p>}
            <div className="flex items-center gap-2 text-13 text-ink-2">
              <span className="eyebrow">tx</span>
              <Address address={txHash} kind="tx" chars={6} explorerUrl={explorerUrl} identicon={false} />
            </div>
            <ol
              ref={log}
              className="num m-0 h-32 w-full list-none overflow-y-auto rounded-card border border-line bg-mono-bg p-3 text-left text-12 leading-5"
              aria-live="polite"
              aria-label="Confirmations"
            >
              {ticks.map((t, i) => (
                <motion.li
                  key={t.id}
                  initial={reduced ? false : { opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: duration.ui, ease: ease.ui }}
                  className={cx("flex justify-between gap-3", t.tone === "earn" ? "text-earn" : t.tone === "build" ? "text-build" : i === ticks.length - 1 ? "text-ink" : "text-ink-3")}
                >
                  <span>{t.label}</span>
                  {t.detail && <span>{t.detail}</span>}
                </motion.li>
              ))}
              {status === "pending" && (
                <li className="animate-blink text-build" aria-hidden>
                  ▍
                </li>
              )}
            </ol>
            <div className="flex items-center gap-2">
              {action}
              {onClose && (
                <Button variant="ghost" onClick={onClose}>
                  Close
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
};
