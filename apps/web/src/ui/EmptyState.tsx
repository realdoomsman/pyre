import type { ReactNode } from "react";
import { Button } from "./Button.js";
import { cx } from "./cx.js";

export interface EmptyStateProps {
  title: ReactNode;
  body?: ReactNode;
  icon?: ReactNode;
  /** Primary action. */
  action?: ReactNode;
  /**
   * `ash`: a dormant thing — desaturated, ink-3, with an optional relight CTA.
   * The relight itself is the consumer's (fund the agent again).
   */
  variant?: "default" | "ash";
  onRelight?: () => void;
  relightLabel?: string;
  className?: string;
}

const Ember = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
    <rect x="4.5" y="4.5" width="19" height="19" rx="3" stroke="currentColor" />
    <path d="M4.5 18.5h19" stroke="currentColor" strokeOpacity="0.5" />
    <rect x="4.5" y="18.5" width="19" height="5" rx="0" fill="currentColor" fillOpacity="0.18" />
  </svg>
);

export const EmptyState = ({ title, body, icon, action, variant = "default", onRelight, relightLabel = "Relight", className }: EmptyStateProps) => {
  const ash = variant === "ash";
  return (
    <div className={cx("flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line px-6 py-12 text-center", className)}>
      <div className={cx("grid h-12 w-12 place-items-center rounded-card border border-line", ash ? "ash text-ink-3" : "bg-fill text-accent")}>{icon ?? <Ember />}</div>
      <div className="max-w-sm">
        <h2 className={cx("text-15 font-medium", ash ? "text-ink-2" : "text-ink")}>{title}</h2>
        {body && <p className="small mt-1 text-ink-3">{body}</p>}
      </div>
      {ash && onRelight ? (
        <Button variant="secondary" size="sm" onClick={onRelight} iconLeft={<span className="h-1.5 w-1.5 rounded-pill bg-accent" aria-hidden />}>
          {relightLabel}
        </Button>
      ) : (
        action
      )}
    </div>
  );
};
