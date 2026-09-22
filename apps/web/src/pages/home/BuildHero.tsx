import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { AppSummaryDto, BuildEventDto } from "@pyre/shared";
import { api } from "../../api/client.js";
import { flatPages, useApps } from "../../api/queries.js";
import type { GlobalFrame } from "../../api/types.js";
import { AppPreview, latestScreenshot } from "../../components/AppPreview.js";
import { consoleRow, isBuildEvent } from "../../components/FeedEvent.js";
import { AGENT_CHIP } from "../../components/CoinCard.js";
import { IconArrowRight } from "../../components/icons.js";
import { useLiveFrames } from "../../layout/LiveContext.js";
import { formatCount, formatUsdCompact, timeAgo } from "../../lib/format.js";
import { Button, Chip, ConsoleFrame, EmptyState, Skeleton, useIsMobile, type ConsoleRow } from "../../ui/index.js";

interface FeedPage {
  events: BuildEventDto[];
  nextCursor: string | null;
}

const BUILDING = new Set(["building", "reviewing", "deploying"]);
const MAX_ROWS = 120;

/** Whichever app the agent is on right now; else the app that shipped most recently. */
const pickSubject = (apps: AppSummaryDto[]): { app: AppSummaryDto; live: boolean } | null => {
  const live = apps.find((a) => BUILDING.has(a.agentState));
  if (live) return { app: live, live: true };
  const shipped = apps.find((a) => a.liveVersion > 0) ?? apps[0];
  return shipped ? { app: shipped, live: false } : null;
};

const useFeedTail = (slug: string | undefined) =>
  useQuery({
    queryKey: ["feed", slug, "tail"],
    queryFn: ({ signal }) => api.get<FeedPage>(`/v1/apps/${slug}/feed?limit=80`, signal),
    enabled: !!slug,
    staleTime: 60_000,
    select: (p) => [...p.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  });

/**
 * The product is the hero. A console streaming the build the agent is on,
 * with the app's latest screenshot beside it; when nothing is building, the
 * last finished build's log tail with a `done` LED — never simulated activity.
 */
export const BuildHero = () => {
  const shipping = useApps("shipping");
  const mobile = useIsMobile();
  const apps = useMemo(() => flatPages(shipping.data?.pages), [shipping.data]);
  const subject = useMemo(() => pickSubject(apps), [apps]);
  const slug = subject?.app.slug;
  const tail = useFeedTail(slug);
  const [liveRows, setLiveRows] = useState<BuildEventDto[]>([]);

  // Reset the live buffer when the subject changes.
  useEffect(() => setLiveRows([]), [slug]);

  const liveState = useLiveFrames(
    useCallback(
      (f: GlobalFrame) => {
        if (!f.event || f.slug !== slug || !isBuildEvent(f.event.payload)) return;
        const e = f.event;
        setLiveRows((rows) => (rows.some((r) => r.id === e.id) ? rows : [...rows, e].slice(-MAX_ROWS)));
      },
      [slug],
    ),
  );

  const events = useMemo(() => {
    const seen = new Set<string>();
    const merged: BuildEventDto[] = [];
    for (const e of [...(tail.data ?? []), ...liveRows]) {
      if (seen.has(e.id) || !isBuildEvent(e.payload)) continue;
      seen.add(e.id);
      merged.push(e);
    }
    return merged.slice(-MAX_ROWS);
  }, [tail.data, liveRows]);

  const rows = useMemo<ConsoleRow[]>(() => events.map(consoleRow), [events]);
  const screenshot = useMemo(() => latestScreenshot(events), [events]);
  const lastFinished = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const p = events[i].payload;
      if (p.type === "JOB_FINISHED" || p.type === "JOB_FAILED") return { at: events[i].createdAt, failed: p.type === "JOB_FAILED" };
    }
    return null;
  }, [events]);

  if (shipping.isPending) {
    return (
      <section className="grid gap-4 lg:grid-cols-[1fr_320px]" aria-busy>
        <Skeleton className="h-[300px] w-full" rounded="card" />
        <Skeleton className="hidden h-[300px] w-full lg:block" rounded="card" />
      </section>
    );
  }
  if (!subject) {
    return (
      <EmptyState
        title="no builds yet"
        body="the first coin to clear its fee threshold puts the agent to work; the log streams here."
        action={
          <Button variant="primary" size="sm" href="/launch">
            launch the first coin
          </Button>
        }
      />
    );
  }

  const { app, live } = subject;
  const agent = AGENT_CHIP[app.agentState];
  const status = live ? (liveState === "open" ? "live" : "idle") : lastFinished?.failed ? "error" : "done";

  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_320px]" aria-label="Live build">
      <ConsoleFrame
        title={
          <span className="inline-flex items-center gap-2">
            <span>
              building <span className="num">${app.ticker}</span> · {app.name}
            </span>
            <Chip tone={agent.tone} dot={agent.dot} size="sm" mono>
              {agent.label}
            </Chip>
          </span>
        }
        session={live ? `budget ${formatUsdCompact(app.budgetMicros)}` : lastFinished ? `finished ${timeAgo(lastFinished.at)}` : `v${app.liveVersion}`}
        status={status}
        rows={tail.isPending ? [] : rows}
        height={mobile ? 220 : 300}
      />
      <aside className="flex flex-col overflow-hidden rounded-card border border-line bg-surface">
        <Link to={`/c/${app.slug}`} className="relative hidden border-b border-line sm:block">
          <AppPreview app={app} screenshot={screenshot} />
          {app.liveUrl && <span className="num absolute bottom-2 left-2 rounded-pill bg-canvas/80 px-2 py-0.5 text-12 text-ink-2">v{app.liveVersion}</span>}
        </Link>
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="num text-14 font-medium text-ink">${app.ticker}</span>
              <span className="truncate text-13 text-ink-2">{app.name}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-13 text-ink-3">{app.oneLiner}</p>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-12">
            <div>
              <dt className="eyebrow">fees → agent</dt>
              <dd className="num text-ink">{formatUsdCompact(app.budgetMicros)}</dd>
            </div>
            <div>
              <dt className="eyebrow">holders</dt>
              <dd className="num text-ink">{formatCount(app.holders)}</dd>
            </div>
          </dl>
          <div className="mt-auto flex items-center gap-2">
            <Button variant="primary" size="sm" href={`/c/${app.slug}?tab=build`} iconRight={<IconArrowRight size={14} />}>
              {live ? "Watch build" : "Read the log"}
            </Button>
            {app.liveUrl && (
              <Button variant="ghost" size="sm" href={app.liveUrl} target="_blank" rel="noreferrer noopener">
                open app
              </Button>
            )}
          </div>
        </div>
      </aside>
    </section>
  );
};
