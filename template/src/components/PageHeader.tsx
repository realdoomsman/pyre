import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** The page's `<h1>`. On the home page it must equal `name` in `pyre.manifest.json`. */
  title: ReactNode;
  /** Small mono line above the title: the coin ticker, a section name. */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** Right-aligned: `<LoginButton>`, a primary action. */
  actions?: ReactNode;
}

/** Top of every page: eyebrow, serif title, one line of context, actions. */
export function PageHeader({ title, eyebrow, description, actions, className, ...rest }: PageHeaderProps) {
  return (
    <header className={cx("flex flex-wrap items-end justify-between gap-x-6 gap-y-4", className)} {...rest}>
      <div className="min-w-0">
        {eyebrow !== undefined ? (
          <p className="mb-2 font-mono text-xs uppercase tracking-[0.14em] text-violet">{eyebrow}</p>
        ) : null}
        <h1 className="text-4xl leading-none text-ink sm:text-5xl">{title}</h1>
        {description !== undefined ? <p className="mt-3 max-w-prose text-base text-ink-muted">{description}</p> : null}
      </div>
      {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
