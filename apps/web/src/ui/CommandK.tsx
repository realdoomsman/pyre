import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { duration, ease, useReducedMotion } from "../lib/motion.js";
import { Kbd } from "./Kbd.js";
import { cx } from "./cx.js";
import { useFocusTrap } from "./useFocusTrap.js";

export interface CommandItem {
  id: string;
  label: string;
  /** Right-aligned mono hint (ticker, shortcut, market cap). */
  hint?: ReactNode;
  icon?: ReactNode;
  group?: string;
  /** Extra search terms (ticker, address, slug). */
  keywords?: string[];
  onSelect: () => void;
}

export interface CommandKProps {
  open: boolean;
  onClose: () => void;
  items: ReadonlyArray<CommandItem>;
  placeholder?: string;
  /** Called on every keystroke — for async search, feed results back through `items`. */
  onQueryChange?: (q: string) => void;
  /** Shown when nothing matches. */
  empty?: ReactNode;
  /** Footer slot (hints). */
  footer?: ReactNode;
}

/** Binds ⌘K / Ctrl+K to `toggle`. */
export const useCommandK = (toggle: () => void) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
};

const matches = (item: CommandItem, q: string): boolean => {
  if (!q) return true;
  const hay = [item.label, item.group ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
};

/**
 * Command palette shell: search input, grouped list, ↑↓ Enter Esc. Filtering
 * is a simple every-term substring match; pass `onQueryChange` for anything
 * smarter and drive `items` from outside.
 */
export const CommandK = ({ open, onClose, items, placeholder = "Search coins, apps, addresses…", onQueryChange, empty, footer }: CommandKProps) => {
  const id = useId();
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useFocusTrap(panel, open, onClose);

  const visible = useMemo(() => items.filter((it) => matches(it, query)), [items, query]);
  const groups = useMemo(() => {
    const order: string[] = [];
    const by: Record<string, CommandItem[]> = {};
    for (const it of visible) {
      const g = it.group ?? "";
      if (!by[g]) {
        by[g] = [];
        order.push(g);
      }
      by[g].push(it);
    }
    return order.map((g) => ({ name: g, items: by[g] }));
  }, [visible]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      onQueryChange?.("");
    }
  }, [open, onQueryChange]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const select = (it: CommandItem) => {
    onClose();
    it.onSelect();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (visible.length ? (i + 1) % visible.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (visible.length ? (i - 1 + visible.length) % visible.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = visible[active];
      if (it) select(it);
    }
  };

  let index = -1;
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="presentation">
          <motion.div
            className="absolute inset-0 bg-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: duration.ui, ease: ease.ui }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -6 }}
            transition={{ duration: duration.ui, ease: ease.ui }}
            onKeyDown={onKeyDown}
            className="relative flex w-full max-w-[560px] flex-col overflow-hidden rounded-card border border-line-2 bg-raised light:shadow-paper"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-3" aria-hidden>
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                data-autofocus
                role="combobox"
                aria-expanded
                aria-controls={`${id}-list`}
                aria-activedescendant={visible[active] ? `${id}-${visible[active].id}` : undefined}
                aria-autocomplete="list"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  onQueryChange?.(e.target.value);
                }}
                placeholder={placeholder}
                className="h-12 w-full bg-transparent text-15 text-ink outline-none placeholder:text-ink-3"
              />
              <Kbd>esc</Kbd>
            </div>
            <div ref={listRef} id={`${id}-list`} role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
              {visible.length === 0 && <div className="px-3 py-8 text-center text-13 text-ink-3">{empty ?? "No matches."}</div>}
              {groups.map((g) => (
                <div key={g.name || "_"} role="group" aria-label={g.name || undefined}>
                  {g.name && <div className="eyebrow px-2.5 pb-1 pt-2">{g.name}</div>}
                  {g.items.map((it) => {
                    index += 1;
                    const i = index;
                    const isActive = i === active;
                    return (
                      <div
                        key={it.id}
                        id={`${id}-${it.id}`}
                        role="option"
                        aria-selected={isActive}
                        data-index={i}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => select(it)}
                        className={cx(
                          "flex cursor-pointer items-center gap-3 rounded-control px-2.5 py-2 text-14",
                          isActive ? "bg-accent-wash text-ink" : "text-ink-2",
                        )}
                      >
                        {it.icon && <span className="grid h-5 w-5 shrink-0 place-items-center text-ink-3">{it.icon}</span>}
                        <span className="min-w-0 flex-1 truncate">{it.label}</span>
                        {it.hint && <span className="num shrink-0 text-12 text-ink-3">{it.hint}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-12 text-ink-3">
              {footer ?? (
                <>
                  <span className="inline-flex items-center gap-1.5">
                    <Kbd keys={["↑", "↓"]} /> navigate
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Kbd>↵</Kbd> open
                  </span>
                </>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
};
