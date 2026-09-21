import { useLayoutEffect } from "react";

/**
 * Puts the whole viewport in a theme while the calling page is mounted
 * (`data-theme` on `<html>`, which every token reads) and restores the
 * previous theme on unmount. Ash Paper is for the app store and docs only.
 */
export const useTheme = (theme: "light" | "dark"): void => {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f4f1ea" : "#0a0a0c");
    return () => {
      if (previous === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#0a0a0c");
    };
  }, [theme]);
};
