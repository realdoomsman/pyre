import { useMemo } from "react";
import type { AppDetailDto, BuildEventDto } from "@pyre/shared";
import { explorerTx } from "../../../env.js";
import { timeAgo } from "../../../lib/format.js";
import { Button, EmptyState, cx } from "../../../ui/index.js";
import { threadItem, type ThreadTone } from "../feed.js";

const DOT: Record<ThreadTone, string> = {
  build: "bg-build",
  earn: "bg-earn",
  burn: "bg-burn",
  warn: "bg-warn",
  neutral: "bg-ink-3",
};

interface Props {
  app: AppDetailDto;
  events: ReadonlyArray<BuildEventDto>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

/** The coin's story in plain sentences: launches, fees, builds, burns, trades — newest first. */
export const ThreadTab = ({ app, events, hasMore, loadingMore, onLoadMore }: Props) => {
  const items = useMemo(() => {
    const out = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const item = threadItem(events[i]!, app.ticker, explorerTx);
      if (item) out.push(item);
    }
    return out;
  }, [events, app.ticker]);

  if (items.length === 0) return <EmptyState title="Quiet so far" body="Launch, fee claims, builds, burns and trades will be written up here as they happen." />;

  return (
    <div className="flex flex-col gap-3">
      <ol className="space-y-4 border-l border-line pl-5">
        {items.map((it) => (
          <li key={it.id} className="relative">
            <span className={cx("absolute -left-[24.5px] top-1.5 h-2 w-2 rounded-pill", DOT[it.tone])} aria-hidden />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              {it.href ? (
                <a href={it.href} target="_blank" rel="noreferrer" className="text-14 font-medium text-ink hover:underline">
                  {it.title}
                </a>
              ) : (
                <span className="text-14 font-medium text-ink">{it.title}</span>
              )}
              <span className="num text-12 text-ink-3">{timeAgo(it.at)}</span>
            </div>
            {it.detail && <p className="small mt-0.5 break-words text-ink-2">{it.detail}</p>}
          </li>
        ))}
      </ol>
      {hasMore && (
        <Button variant="ghost" size="sm" className="self-start" onClick={onLoadMore} loading={loadingMore}>
          Load earlier
        </Button>
      )}
    </div>
  );
};
