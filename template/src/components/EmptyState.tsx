import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  /** What the user can do about it, in one sentence. */
  description?: ReactNode;
  /** Usually one `<Button>`. */
  action?: ReactNode;
}

/** What a list or result area shows before there is anything in it. Words, not illustrations. */
export function EmptyState({ title, description, action, className, ...rest }: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center gap-3 rounded-card border border-dashed border-border-strong px-6 py-10 text-center",
        className,
      )}
      {...rest}
    >
      <p className="font-display text-xl text-ink">{title}</p>
      {description !== undefined ? <p className="max-w-sm text-sm text-ink-muted">{description}</p> : null}
      {action !== undefined ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
