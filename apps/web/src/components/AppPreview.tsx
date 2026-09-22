import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BuildEventDto } from "@pyre/shared";
import { api } from "../api/client.js";
import { Avatar, cx } from "../ui/index.js";

export interface Screenshot {
  url: string;
  label: string;
}

/** The newest SCREENSHOT the agent posted to an app's feed, or null before the first one. */
export const latestScreenshot = (events: ReadonlyArray<BuildEventDto>): Screenshot | null => {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i].payload;
    if (p.type === "SCREENSHOT") return { url: p.url, label: p.label };
  }
  return null;
};

export const useLatestScreenshot = (slug: string | undefined) =>
  useQuery({
    queryKey: ["feed", slug, "screenshot"],
    queryFn: ({ signal }) => api.get<{ events: BuildEventDto[] }>(`/v1/apps/${slug}/feed?limit=40`, signal),
    enabled: !!slug,
    staleTime: 5 * 60_000,
    select: (p) => latestScreenshot([...p.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))),
  });

/**
 * A 16:10 window on the app: its latest screenshot, or — before the agent has
 * posted one — the coin image as a blurred backdrop behind a small avatar.
 * Never an iframe: third-party apps are not reliably framable.
 */
export const AppPreview = ({ app, screenshot, className }: { app: { name: string; ticker: string; imageUrl: string; screenshotUrl?: string | null }; screenshot: Screenshot | null | undefined; className?: string }) => {
  // The live deployment's own capture wins; a feed-derived one covers apps mid-build; a 404 falls back.
  const src = app.screenshotUrl ?? screenshot?.url ?? null;
  const [broken, setBroken] = useState<string | null>(null);
  const shown = src && broken !== src ? src : null;
  return (
    <span className={cx("relative block aspect-[16/10] overflow-hidden bg-mono-bg", className)}>
      {shown ? (
        <img src={shown} alt={`${app.name}: ${screenshot?.label ?? "home"}`} loading="lazy" decoding="async" onError={() => setBroken(shown)} className="h-full w-full object-cover object-top" />
      ) : (
        <span className="grid h-full w-full place-items-center">
          {app.imageUrl ? (
            <img src={app.imageUrl} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-125 object-cover opacity-40 blur-2xl" />
          ) : (
            <span className="absolute inset-0 bg-[radial-gradient(80%_70%_at_50%_100%,rgba(122,102,245,0.35),rgba(62,139,255,0.12)_45%,transparent_80%)]" aria-hidden />
          )}
          <span className="relative flex flex-col items-center gap-2">
            <Avatar src={app.imageUrl} name={app.ticker} size={40} shape="square" />
            <span className="eyebrow">no screenshot yet</span>
          </span>
        </span>
      )}
    </span>
  );
};
