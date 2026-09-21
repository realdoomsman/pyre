import { useCallback, useEffect, useState } from "react";

/** ⌘K / Ctrl+K state. Lives apart from `Palette.tsx` so the shortcut works before the palette chunk loads. */
export const usePalette = () => {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const show = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMounted(true);
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, mounted, show, hide: () => setOpen(false) };
};
