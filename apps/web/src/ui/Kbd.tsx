import type { ReactNode } from "react";
import { cx } from "./cx.js";

/** A keycap. Pass `keys` for a chord: `<Kbd keys={["⌘", "K"]} />`. */
export const Kbd = ({ keys, children, className }: { keys?: string[]; children?: ReactNode; className?: string }) => {
  const caps = keys ?? [children];
  return (
    <span className={cx("inline-flex items-center gap-0.5", className)}>
      {caps.map((k, i) => (
        <kbd
          key={i}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line-2 bg-fill px-1 text-12 font-medium text-ink-2 shadow-[inset_0_-1px_0_var(--color-line-2)]"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
};
