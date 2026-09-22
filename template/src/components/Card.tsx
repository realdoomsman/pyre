import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Rendered as an `<h2>` in the display face. */
  title?: ReactNode;
  /** One line under the title, muted. */
  description?: ReactNode;
  /** Right-aligned next to the title: a button, a chip. */
  actions?: ReactNode;
  children?: ReactNode;
}

/** Surface `#111114`, 1px `#1F1F24` border, 8px radius. The only container for grouped content. */
export function Card({ title, description, actions, className, children, ...rest }: CardProps) {
  return (
    <section className={cx("rounded-card border border-border bg-surface p-5", className)} {...rest}>
      {title !== undefined || actions !== undefined ? (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title !== undefined ? <h2 className="text-xl leading-tight text-ink">{title}</h2> : null}
            {description !== undefined ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
          </div>
          {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
