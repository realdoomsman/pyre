import { createContext, forwardRef, useContext, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx } from "./cx.js";

/*
 * Form primitives. `Field` owns the label/hint/error and wires ids and aria;
 * the controls are plain native elements with the house chrome, so browsers
 * keep their own autofill, validation and mobile keyboards.
 */

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Right-aligned mono annotation beside the label (e.g. a balance). */
  meta?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

/** Ids a Field hands to the control it wraps; explicit `id` / `aria-describedby` on the control win. */
const FieldContext = createContext<{ id: string; describedBy?: string } | null>(null);

export const Field = ({ label, hint, error, required, meta, htmlFor, className, children }: FieldProps) => {
  const auto = useId();
  const id = htmlFor ?? auto;
  const noteId = `${id}-note`;
  const describedBy = error || hint ? noteId : undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy }}>
      <div className={cx("flex flex-col gap-1.5", className)}>
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={id} className="text-13 font-medium text-ink">
            {label}
            {required && (
              <span className="ml-1 text-burn" aria-hidden>
                *
              </span>
            )}
          </label>
          {meta && <span className="num text-12 text-ink-3">{meta}</span>}
        </div>
        {children}
        {error ? (
          <p id={noteId} className="text-12 text-danger" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p id={noteId} className="text-12 text-ink-3">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
};

const useFieldWiring = (rest: { id?: string; "aria-describedby"?: string }) => {
  const field = useContext(FieldContext);
  return { id: rest.id ?? field?.id, "aria-describedby": rest["aria-describedby"] ?? field?.describedBy };
};

const CONTROL =
  "w-full min-w-0 rounded-control border bg-canvas text-15 text-ink placeholder:text-ink-3 transition-[border-color,background-color] duration-(--duration-ui) ease-(--ease-ui) focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-55";

const border = (invalid?: boolean) => (invalid ? "border-danger" : "border-line-2 hover:border-line-3");

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  invalid?: boolean;
  /** Mono adornment on the left (e.g. `$`). */
  prefix?: ReactNode;
  /** Mono adornment on the right (e.g. `ETH`, `MAX`). */
  suffix?: ReactNode;
  /** Numbers and addresses set mono. */
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid, prefix, suffix, mono, className, ...rest }, ref) {
  const wiring = useFieldWiring(rest);
  const control = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      {...rest}
      {...wiring}
      className={cx(CONTROL, border(invalid), "h-10 px-3", mono && "num", prefix ? "pl-8" : undefined, suffix ? "pr-14" : undefined, className)}
    />
  );
  if (!prefix && !suffix) return control;
  return (
    <div className="relative">
      {prefix && <span className="num pointer-events-none absolute inset-y-0 left-3 flex items-center text-14 text-ink-3">{prefix}</span>}
      {control}
      {suffix && <span className="num absolute inset-y-0 right-3 flex items-center text-12 uppercase tracking-[0.04em] text-ink-3">{suffix}</span>}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, className, ...rest }, ref) {
  const wiring = useFieldWiring(rest);
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      rows={4}
      {...rest}
      {...wiring}
      className={cx(CONTROL, border(invalid), "resize-y px-3 py-2.5 leading-6", className)}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ invalid, className, children, ...rest }, ref) {
  const wiring = useFieldWiring(rest);
  return (
    <div className="relative">
      <select ref={ref} aria-invalid={invalid || undefined} {...rest} {...wiring} className={cx(CONTROL, border(invalid), "h-10 appearance-none pl-3 pr-9", className)}>
        {children}
      </select>
      <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});
