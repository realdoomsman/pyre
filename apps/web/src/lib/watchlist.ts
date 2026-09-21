import { useCallback, useSyncExternalStore } from "react";

/*
 * Watched coins, by slug, in localStorage. A tiny external store so every
 * card's star and the ⌘K "watching" group agree without a provider.
 */
const KEY = "pyre_watchlist";
const listeners = new Set<() => void>();
let cache: readonly string[] | null = null;

const read = (): readonly string[] => {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
};

const write = (next: readonly string[]) => {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: in-memory only */
  }
  for (const l of listeners) l();
};

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null;
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
};

const EMPTY: readonly string[] = [];

export const useWatchlist = () => {
  const slugs = useSyncExternalStore(subscribe, read, () => EMPTY);
  const toggle = useCallback((slug: string) => {
    const current = read();
    write(current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug]);
  }, []);
  return { slugs, toggle, has: (slug: string) => slugs.includes(slug) };
};
