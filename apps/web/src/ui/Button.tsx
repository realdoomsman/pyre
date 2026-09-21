import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { cx } from "./cx.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "sm" | "md" | "lg";

interface Common {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Accessible name for `variant="icon"` buttons (they have no visible text). */
  label?: string;
}

type ButtonAsButton = Common & ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };
type ButtonAsLink = Common & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; disabled?: boolean };
export type ButtonProps = ButtonAsButton | ButtonAsLink;

const BASE =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium transition-[background-color,border-color,color,opacity] duration-(--duration-ui) ease-(--ease-ui) disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "rounded-pill bg-accent text-accent-ink hover:not-disabled:bg-accent-strong active:not-disabled:bg-accent-strong",
  secondary: "rounded-pill border border-line-2 bg-fill text-ink hover:not-disabled:border-line-3 hover:not-disabled:bg-fill-2",
  ghost: "rounded-pill text-ink-2 hover:not-disabled:bg-fill hover:not-disabled:text-ink",
  danger:
    "rounded-pill border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_12%,transparent)] text-danger hover:not-disabled:bg-[color-mix(in_oklab,var(--color-danger)_20%,transparent)]",
  icon: "rounded-control text-ink-2 hover:not-disabled:bg-fill hover:not-disabled:text-ink",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-13",
  md: "h-10 px-4 text-14",
  lg: "h-12 px-6 text-15",
};

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 w-8",
  md: "h-9 w-9",
  lg: "h-11 w-11",
};

export const Spinner = ({ className }: { className?: string }) => (
  <svg className={cx("animate-spin", className)} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
    <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(props, ref) {
  const { variant = "primary", size = "md", loading = false, iconLeft, iconRight, label, className, children, ...rest } = props;
  const isIcon = variant === "icon";
  const classes = cx(BASE, VARIANT[variant], isIcon ? ICON_SIZE[size] : SIZE[size], loading && "cursor-progress", className);
  const content = (
    <>
      {loading && (
        <span className="absolute inset-0 grid place-items-center" aria-hidden>
          <Spinner />
        </span>
      )}
      <span className={cx("inline-flex items-center gap-2", loading && "invisible")}>
        {iconLeft}
        {children}
        {iconRight}
      </span>
    </>
  );
  if ("href" in rest && typeof rest.href === "string") {
    const { disabled, ...anchor } = rest as ButtonAsLink;
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        {...anchor}
        aria-disabled={disabled || loading || undefined}
        aria-label={label}
        aria-busy={loading || undefined}
        className={classes}
        tabIndex={disabled ? -1 : anchor.tabIndex}
      >
        {content}
      </a>
    );
  }
  const button = rest as ButtonAsButton;
  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      type={button.type ?? "button"}
      {...button}
      disabled={button.disabled || loading}
      aria-label={label}
      aria-busy={loading || undefined}
      className={classes}
    >
      {content}
    </button>
  );
});
