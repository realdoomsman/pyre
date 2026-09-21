import { useEffect, useRef, useState } from "react";
import { env } from "../env.js";

export type SseState = "connecting" | "open" | "reconnecting" | "closed";

interface Options<T> {
  /** Called for each parsed `data:` payload. */
  onMessage: (msg: T, eventId: string | null) => void;
  /** Initial `Last-Event-ID` (e.g. newest id from the REST backfill). */
  lastEventId?: string | null;
  /** Named `event:` types to listen for in addition to the default `message`. */
  events?: readonly string[];
  enabled?: boolean;
}

/**
 * EventSource with exponential-backoff reconnect. Browsers send `Last-Event-ID`
 * automatically on their own retries, but not on a fresh EventSource, so we carry
 * the last seen id across our manual reconnects via the `lastEventId` query param.
 */
export const useSse = <T>(
  path: string | null,
  { onMessage, lastEventId = null, events = [], enabled = true }: Options<T>,
): SseState => {
  const [state, setState] = useState<SseState>("closed");
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const lastIdRef = useRef<string | null>(lastEventId);
  if (lastEventId && !lastIdRef.current) lastIdRef.current = lastEventId;

  useEffect(() => {
    if (!path || !enabled) {
      setState("closed");
      return;
    }
    let es: EventSource | null = null;
    let attempt = 0;
    let timer: number | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const sep = path.includes("?") ? "&" : "?";
      const url = lastIdRef.current
        ? `${env.apiOrigin}${path}${sep}lastEventId=${encodeURIComponent(lastIdRef.current)}`
        : `${env.apiOrigin}${path}`;
      setState(attempt === 0 ? "connecting" : "reconnecting");
      es = new EventSource(url);
      es.onopen = () => {
        attempt = 0;
        setState("open");
      };
      const onFrame = (raw: Event) => {
        const ev = raw as MessageEvent<string>; // EventSource dispatches MessageEvent for data frames
        if (ev.lastEventId) lastIdRef.current = ev.lastEventId;
        if (!ev.data || ev.data === "ping") return;
        try {
          onMessageRef.current(JSON.parse(ev.data) as T, ev.lastEventId || null);
        } catch {
          // ignore malformed frames
        }
      };
      es.onmessage = onFrame;
      for (const name of events) es.addEventListener(name, onFrame);
      es.onerror = () => {
        es?.close();
        es = null;
        if (disposed) return;
        attempt += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.random() * 500;
        setState("reconnecting");
        timer = window.setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      es?.close();
      setState("closed");
    };
  }, [path, enabled]);

  return state;
};
