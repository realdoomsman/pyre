import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.js";

export type ChipTone = "neutral" | "accent" | "build" | "earn" | "burn" | "warn";

const TONE: Record<ChipTone, string> = {
  neutral: "border-line bg-fill text-ink-2",
  accent: "border-transparent bg-accent-wash text-accent",
  build: "border-transparent bg-[color-mix(in_oklab,var(--color-build)_14%,transparent)] text-build",
  earn: "border-transparent bg-[color-mix(in_oklab,var(--color-earn)_14%,transparent)] text-earn",
  burn: "border-transparent bg-[color-mix(in_oklab,var(--color-burn)_14%,transparent)] text-burn",
  warn: "border-transparent bg-[color-mix(in_oklab,var(--color-warn)_14%,transparent)] text-warn",
};

interface Base {
  tone?: ChipTone;
  size?: "sm" | "md";
  /** Leading status dot in the tone colour. */
  dot?: boolean;
  /** Mono uppercase label styling (tickers, statuses). */
  mono?: boolean;
  children: ReactNode;
}

type Static = Base & HTMLAttributes<HTMLSpanElement> & { selected?: undefined; onClick?: undefined };
type Toggle = Base & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & { selected: boolean; onClick: () => void };
export type ChipProps = Static | Toggle;

const BASE = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill border font-medium leading-none";

/** A label, count or filter. Pass `selected` + `onClick` to make it a toggle. */
export const Chip = (props: ChipProps) => {
  const { tone = "neutral", size = "md", dot, mono, className, children, ...rest } = props;
  const classes = cx(
    BASE,
    size === "sm" ? "h-5 px-2 text-12" : "h-6 px-2.5 text-12",
    mono && "num uppercase tracking-[0.04em]",
    TONE[tone],
    className,
  );
  const inner = (
    <>
      {dot && <span className="h-1.5 w-1.5 rounded-pill bg-current" aria-hidden />}
      {children}
    </>
  );
  if ("selected" in rest && typeof rest.selected === "boolean") {
    const { selected, onClick, ...button } = rest as Toggle;
    return (
      <button
        type="button"
        {...button}
        aria-pressed={selected}
        onClick={onClick}
        className={cx(
          classes,
          "cursor-pointer transition-[background-color,border-color,color] duration-(--duration-ui) ease-(--ease-ui)",
          selected ? "border-accent bg-accent-wash text-accent" : "hover:border-line-2 hover:bg-fill-2 hover:text-ink",
        )}
      >
        {inner}
      </button>
    );
  }
  return (
    <span {...(rest as Static)} className={classes}>
      {inner}
    </span>
  );
};
