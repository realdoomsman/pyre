import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Visible label. Pass `aria-label` instead only when the surrounding copy already names the field. */
  label?: ReactNode;
  /** Muted helper text under the field. */
  hint?: ReactNode;
  /** Error message; turns the border red and is announced to screen readers. */
  error?: ReactNode;
}

/** Text field on the surface colour with a violet focus ring. Numbers get `font-mono` automatically. */
export function Input({ label, hint, error, className, id, type = "text", ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const described = cx(hint !== undefined && hintId, error !== undefined && errorId) || undefined;

  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      {label !== undefined ? (
        <label className="text-sm text-ink-muted" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        aria-describedby={described}
        aria-invalid={error !== undefined || undefined}
        className={cx(
          "h-10 w-full rounded-card border bg-bg px-3 text-sm text-ink outline-none transition-colors",
          "placeholder:text-ink-faint focus:border-violet disabled:cursor-not-allowed disabled:opacity-50",
          type === "number" ? "font-mono tabular-nums" : "",
          error !== undefined ? "border-danger" : "border-border hover:border-border-strong",
        )}
        id={inputId}
        type={type}
        {...rest}
      />
      {error !== undefined ? (
        <p className="text-sm text-danger" id={errorId} role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className="text-sm text-ink-faint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
