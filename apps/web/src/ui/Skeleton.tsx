import { cx } from "./cx.js";

/**
 * A quiet placeholder: fill colour with a slow breathe, no shimmer sweep.
 * Size it with `className` (`h-4 w-40`) or ask for `lines` of text.
 */
export const Skeleton = ({ className, lines, rounded = "control" }: { className?: string; lines?: number; rounded?: "control" | "card" | "pill" }) => {
  const shape = cx("animate-breathe bg-fill-2", rounded === "pill" ? "rounded-pill" : rounded === "card" ? "rounded-card" : "rounded-control");
  if (lines) {
    return (
      <div className={cx("space-y-2", className)} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={cx(shape, "h-3.5")} style={{ width: i === lines - 1 ? "62%" : "100%" }} />
        ))}
      </div>
    );
  }
  return <div className={cx(shape, className)} aria-hidden />;
};
