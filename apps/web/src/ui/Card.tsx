import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.js";

export type CardTone = "surface" | "raised" | "inset" | "earn" | "burn" | "build";

const TONE: Record<CardTone, string> = {
  surface: "bg-surface border-line",
  raised: "bg-raised border-line-2",
  inset: "bg-mono-bg border-line",
  earn: "bg-[color-mix(in_oklab,var(--color-earn)_6%,var(--color-surface))] border-[color-mix(in_oklab,var(--color-earn)_30%,var(--color-line))]",
  burn: "bg-[color-mix(in_oklab,var(--color-burn)_6%,var(--color-surface))] border-[color-mix(in_oklab,var(--color-burn)_30%,var(--color-line))]",
  build: "bg-[color-mix(in_oklab,var(--color-build)_6%,var(--color-surface))] border-[color-mix(in_oklab,var(--color-build)_30%,var(--color-line))]",
};

export interface CardProps extends HTMLAttributes<HTMLElement> {
  tone?: CardTone;
  /** 0 removes padding for full-bleed content (tables, charts). */
  padding?: 0 | "sm" | "md" | "lg";
  /** Hover lifts the hairline; use for cards that navigate. */
  interactive?: boolean;
  /** Dormant: desaturated with reduced contrast. */
  ash?: boolean;
  as?: "div" | "section" | "article" | "li";
}

const PAD = { 0: "", sm: "p-3", md: "p-4 sm:p-5", lg: "p-6 sm:p-8" } as const;

export const Card = ({ tone = "surface", padding = "md", interactive, ash, as: Tag = "div", className, ...rest }: CardProps) => (
  <Tag
    {...rest}
    className={cx(
      "rounded-card border light:shadow-paper",
      TONE[tone],
      PAD[padding],
      interactive &&
        "cursor-pointer transition-[border-color,background-color] duration-(--duration-ui) ease-(--ease-ui) hover:border-line-3 focus-within:border-line-3 has-[>a:focus-visible]:outline-2 has-[>a:focus-visible]:outline-offset-2 has-[>a:focus-visible]:outline-accent",
      ash && "ash",
      className,
    )}
  />
);

export interface CardHeaderProps {
  /** Mono eyebrow above the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned slot: chips, buttons, a status LED. */
  actions?: ReactNode;
  className?: string;
}

export const CardHeader = ({ eyebrow, title, description, actions, className }: CardHeaderProps) => (
  <header className={cx("mb-4 flex items-start justify-between gap-4", className)}>
    <div className="min-w-0">
      {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
      <h2 className="h3 truncate text-ink">{title}</h2>
      {description && <p className="small mt-0.5 text-ink-2">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </header>
);
