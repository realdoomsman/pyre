import { useMemo } from "react";
import type { AppDetailDto, BuildEventDto } from "@pyre/shared";
import type { SseState } from "../../../api/sse.js";
import { formatUsd } from "../../../lib/format.js";
import { useVenueLinks } from "../../../lib/venue.js";
import { Button, Chip, ConsoleFrame, Progress, type ConsoleFrameProps } from "../../../ui/index.js";
import { consoleRow } from "../feed.js";

interface Props {
  app: AppDetailDto;
  events: ReadonlyArray<BuildEventDto>;
  stream: SseState;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

const consoleStatus = (app: AppDetailDto, stream: SseState): ConsoleFrameProps["status"] => {
  if (app.agentState === "building" || app.agentState === "reviewing" || app.agentState === "deploying") return stream === "open" ? "live" : "idle";
  if (app.lastBuild?.status === "FAILED") return "error";
  if (app.lastBuild?.status === "DONE" || app.lastBuild?.status === "SUCCEEDED") return "done";
  return "idle";
};

/** The console, fed by history plus the live stream, with milestones and budget burn pinned above. */
export const BuildLogTab = ({ app, events, stream, hasMore, loadingMore, onLoadMore }: Props) => {
  const venue = useVenueLinks(app);
  const rows = useMemo(() => events.map((e) => consoleRow(e, venue)), [events, venue]);
  const budget = Number(app.budgetMicros);
  const spent = Number(app.spentMicros);
  const used = budget + spent > 0 ? spent / (budget + spent) : 0;
  return (
    <div className="flex flex-col gap-3">
      <ConsoleFrame
        title={`${app.name} · build log`}
        session={app.lastBuild ? `job ${app.lastBuild.id.slice(0, 8)}` : undefined}
        status={consoleStatus(app, stream)}
        rows={rows}
        height={420}
        toolbar={
          <>
            {app.milestones.map((m) => (
              <Chip key={m} tone="build" size="sm" mono>
                {m}
              </Chip>
            ))}
            {app.milestones.length === 0 && <span className="eyebrow">no milestones yet</span>}
            <span className="ml-auto inline-flex items-center gap-2">
              <span className="eyebrow">Spent</span>
              <span className="num text-12 text-ink-2">
                {formatUsd(app.spentMicros)} <span className="text-ink-3">/ {formatUsd(BigInt(app.budgetMicros) + BigInt(app.spentMicros))}</span>
              </span>
              <Progress value={used} tone="build" size="xs" className="w-16" label="Budget used" />
            </span>
          </>
        }
      />
      <div className="flex items-center justify-between text-12 text-ink-3">
        <span className="num">
          {events.length.toLocaleString("en-US")} events · stream {stream}
        </span>
        {hasMore && (
          <Button variant="ghost" size="sm" onClick={onLoadMore} loading={loadingMore}>
            Load earlier
          </Button>
        )}
      </div>
    </div>
  );
};
