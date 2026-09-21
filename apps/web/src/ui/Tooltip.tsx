import { cloneElement, useId, useState, type ReactElement, type ReactNode } from "react";
import { cx } from "./cx.js";

export interface TooltipProps {
  content: ReactNode;
  side?: "top" | "bottom";
  /** A single focusable element; it receives `aria-describedby`. */
  children: ReactElement<Record<string, unknown>>;
  className?: string;
}

/**
 * Hover/focus tooltip with no positioning engine: it centres on the trigger
 * and flips only by prop. Keep content to a line or two.
 */
export const Tooltip = ({ content, side = "top", children, className }: TooltipProps) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = cloneElement(children, {
    "aria-describedby": open ? id : undefined,
    onMouseEnter: (e: unknown) => {
      setOpen(true);
      (children.props.onMouseEnter as ((e: unknown) => void) | undefined)?.(e);
    },
    onMouseLeave: (e: unknown) => {
      setOpen(false);
      (children.props.onMouseLeave as ((e: unknown) => void) | undefined)?.(e);
    },
    onFocus: (e: unknown) => {
      setOpen(true);
      (children.props.onFocus as ((e: unknown) => void) | undefined)?.(e);
    },
    onBlur: (e: unknown) => {
      setOpen(false);
      (children.props.onBlur as ((e: unknown) => void) | undefined)?.(e);
    },
  });
  return (
    <span className={cx("relative inline-flex", className)}>
      {trigger}
      <span
        role="tooltip"
        id={id}
        className={cx(
          "pointer-events-none absolute left-1/2 z-40 w-max max-w-64 -translate-x-1/2 rounded-control border border-line-2 bg-raised px-2.5 py-1.5 text-12 leading-4 text-ink transition-[opacity,transform] duration-(--duration-ui) ease-(--ease-ui)",
          side === "top" ? "bottom-full mb-2" : "top-full mt-2",
          open ? "opacity-100" : cx("opacity-0", side === "top" ? "translate-y-1" : "-translate-y-1"),
        )}
      >
        {content}
      </span>
    </span>
  );
};
