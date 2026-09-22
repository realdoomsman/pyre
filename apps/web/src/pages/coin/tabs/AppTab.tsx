import { useMemo, useState } from "react";
import type { AppDetailDto, BuildEventDto } from "@pyre/shared";
import { formatPct, timeAgo } from "../../../lib/format.js";
import { Button, Card, CardHeader, Chip, EmptyState, Skeleton } from "../../../ui/index.js";
import { deployments } from "../feed.js";

interface Props {
  app: AppDetailDto;
  events: ReadonlyArray<BuildEventDto>;
  onRelight?: () => void;
}

const IconExternal = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M5 2.5H2.5v7h7V7M7 2.5h2.5V5M9.5 2.5 5.5 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Live preview, who uses it, and the changelog the agent wrote by deploying. */
export const AppTab = ({ app, events, onRelight }: Props) => {
  const [loaded, setLoaded] = useState(false);
  const deploys = useMemo(() => deployments(events), [events]);

  const live = app.liveUrl && app.status === "LIVE";

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card padding={0} className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            <div className="eyebrow">Live app</div>
            <div className="num truncate text-13 text-ink-2">{app.liveUrl ?? "not deployed"}</div>
          </div>
          {live && (
            <Button variant="secondary" size="sm" href={app.liveUrl!} target="_blank" rel="noreferrer" iconRight={<IconExternal />}>
              Open app
            </Button>
          )}
        </div>
        {live ? (
          <div className="relative aspect-[4/3] w-full bg-canvas sm:aspect-video">
            {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
            <iframe
              src={app.liveUrl!}
              title={`${app.name} preview`}
              loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer"
              onLoad={() => setLoaded(true)}
              className="h-full w-full border-0"
            />
          </div>
        ) : app.status === "DORMANT" ? (
          <EmptyState variant="ash" title="The agent went dormant" body="Fees ran dry before the app shipped. Relight it to fund another build." onRelight={onRelight} className="m-4" />
        ) : (
          <EmptyState title="Nothing deployed yet" body="The first deploy shows up here the moment the agent ships it." className="m-4" />
        )}
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            eyebrow="Usage"
            title={`${app.usersCount.toLocaleString("en-US")} users`}
            description={`free to use · uptime ${formatPct(app.uptimeBps / 10_000, 1)}${app.liveVersion > 0 ? ` · live v${app.liveVersion}` : ""}`}
          />
          <p className="small text-ink-3">Nothing in the app costs money. Holder perks unlock by holding ${app.ticker}; the coin's trading fees pay for the agent that builds it.</p>
        </Card>

        <Card>
          <CardHeader eyebrow="Changelog" title={`${deploys.length} deploys`} description="Every version the agent shipped." />
          {deploys.length === 0 ? (
            <p className="small text-ink-3">No deploys yet.</p>
          ) : (
            <ol className="space-y-3 border-l border-line pl-4">
              {deploys.map((d) => (
                <li key={d.id} className="relative">
                  <span className="absolute -left-[20.5px] top-1.5 h-2 w-2 rounded-pill bg-build" aria-hidden />
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone="build" size="sm" mono>
                      v{d.version}
                    </Chip>
                    <a href={d.url} target="_blank" rel="noreferrer" className="num truncate text-13 text-ink-2 hover:text-ink">
                      {d.url.replace(/^https?:\/\//, "")}
                    </a>
                    <span className="num ml-auto text-12 text-ink-3">{timeAgo(d.at)}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
};
