import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useGlobalStream } from "../api/queries.js";
import type { SseState } from "../api/sse.js";
import type { GlobalFrame } from "../api/types.js";

/*
 * One EventSource for the whole shell. The proof strip, the live tape and the
 * build hero all subscribe here instead of each opening `/v1/apps/stream`.
 */

type Listener = (frame: GlobalFrame) => void;

interface LiveApi {
  state: SseState;
  subscribe: (fn: Listener) => () => void;
}

const LiveCtx = createContext<LiveApi | null>(null);

export const LiveProvider = ({ children }: { children: ReactNode }) => {
  const listeners = useRef(new Set<Listener>());
  const onFrame = useCallback((f: GlobalFrame) => {
    for (const l of listeners.current) l(f);
  }, []);
  const state = useGlobalStream(onFrame);
  const value = useMemo<LiveApi>(
    () => ({
      state,
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
    }),
    [state],
  );
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>;
};

/** Subscribe to global frames for the lifetime of the component. */
export const useLiveFrames = (fn: Listener | null): SseState => {
  const ctx = useContext(LiveCtx);
  if (!ctx) throw new Error("useLiveFrames must be used inside <LiveProvider>");
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => ctx.subscribe((f) => ref.current?.(f)), [ctx]);
  return ctx.state;
};
