import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx.js";

export interface TabItem<K extends string = string> {
  id: K;
  label: ReactNode;
  count?: number | string;
  disabled?: boolean;
}

export interface TabsProps<K extends string> {
  items: ReadonlyArray<TabItem<K>>;
  value: K;
  onChange: (id: K) => void;
  /** Ties `aria-controls` to the panel: the panel must use `id={panelId(id)}`. */
  name?: string;
  size?: "sm" | "md";
  /** `line` underlines the active tab; `pill` fills it. */
  variant?: "line" | "pill";
  className?: string;
}

export const tabId = (name: string, id: string) => `${name}-tab-${id}`;
export const panelId = (name: string, id: string) => `${name}-panel-${id}`;

/**
 * Roving-tabindex tab strip. Arrow keys move, Home/End jump, the active
 * indicator slides between items (CSS transition on measured geometry).
 */
export const Tabs = <K extends string>({ items, value, onChange, name = "tabs", size = "md", variant = "line", className }: TabsProps<K>) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !active) return;
    const measure = () => setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [value, items]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.filter((t) => !t.disabled);
    const i = enabled.findIndex((t) => t.id === value);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    else return;
    e.preventDefault();
    const target = enabled[next];
    onChange(target.id);
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(name, target.id))}`)?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={onKeyDown}
      className={cx(
        "relative flex max-w-full items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        variant === "line" && "hairline",
        variant === "pill" && "rounded-pill bg-fill p-1",
        className,
      )}
    >
      {items.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            id={tabId(name, t.id)}
            role="tab"
            type="button"
            aria-selected={active}
            aria-controls={panelId(name, t.id)}
            tabIndex={active ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={cx(
              "relative z-10 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-(--duration-ui) ease-(--ease-ui) disabled:opacity-40",
              size === "sm" ? "h-8 px-2.5 text-13" : "h-10 px-3 text-14",
              variant === "pill" && "rounded-pill",
              active ? cx("text-ink", variant === "pill" && "text-accent-ink") : "text-ink-2 hover:text-ink",
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={cx("num rounded-pill px-1.5 text-12 leading-4", active && variant === "pill" ? "bg-[rgba(0,0,0,0.15)]" : "bg-fill-2 text-ink-3")}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
      {indicator && (
        <span
          aria-hidden
          className={cx(
            "absolute transition-[left,width] duration-(--duration-ui) ease-(--ease-ui)",
            variant === "line" ? "-bottom-px h-0.5 rounded-pill bg-accent" : "inset-y-1 rounded-pill bg-accent",
          )}
          style={{ left: indicator.left, width: indicator.width }}
        />
      )}
    </div>
  );
};
