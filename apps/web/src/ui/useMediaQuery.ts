import { useSyncExternalStore } from "react";

export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined") return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
    () => false,
  );

/** Below the `md` breakpoint: trays instead of side sheets, bottom bars instead of nav. */
export const useIsMobile = (): boolean => useMediaQuery("(max-width: 767px)");
