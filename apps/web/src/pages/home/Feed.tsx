import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LAUNCH_STAKE_WEI, type AppSort } from "@pyre/shared";
import { flatPages, useApps, useStats } from "../../api/queries.js";
import { CoinCard } from "../../components/CoinCard.js";
import { IconArrowRight } from "../../components/icons.js";
import { formatEth } from "../../lib/format.js";
import { Button, EmptyState, Skeleton, Tabs, panelId, type TabItem } from "../../ui/index.js";

const PAGE_STEP = 12;

const SORTS: ReadonlyArray<{ id: AppSort; label: string }> = [
  { id: "trending", label: "Trending" },
  { id: "new", label: "New" },
  { id: "heating", label: "Heating" },
  { id: "graduated", label: "Graduated" },
  { id: "shipping", label: "Shipping" },
  { id: "burning", label: "Burning" },
];

const isSort = (s: string | null): s is AppSort => SORTS.some((x) => x.id === s);

const EMPTY_COPY: Record<AppSort, { title: string; body: string }> = {
  trending: { title: "nothing trending yet", body: "trending needs fills. the first coins to trade land here." },
  new: { title: "no coins yet", body: "the newest launches land here the second they clear intake." },
  heating: { title: "nothing heating", body: "a coin heats up as its curve climbs toward 4.2 ETH." },
  graduated: { title: "no graduates yet", body: "a curve that raises 4.2 ETH moves to a uniswap v4 pool and shows up here." },
  shipping: { title: "no agent at work", body: "once a coin's fees reach $50 the agent starts building and the coin lands here." },
  burning: { title: "nothing burning", body: "app revenue buys the coin back and burns it. the first burn lands here." },
  revenue: { title: "no revenue yet", body: "apps that earn land here." },
};

/** Before the first launch: one empty state for the whole feed, no tabs of zeros. */
export const FeedEmpty = () => (
  <section aria-label="Ranked feed" className="flex min-h-[60svh] flex-col items-center justify-center rounded-card border border-dashed border-line px-6 py-16 text-center">
    <div className="eyebrow text-ink-3">the feed</div>
    <h2 className="display mt-3 text-36 sm:text-48">
      nothing has launched <em>yet</em>. be first.
    </h2>
    <p className="body mx-auto mt-3 max-w-lg text-ink-2">
      describe an app in a paragraph and stake {formatEth(LAUNCH_STAKE_WEI)}. the coin's trading fees pay an agent to build the app; the app's revenue buys the coin back and burns it.
    </p>
    <div className="mt-6 flex justify-center">
      <Button variant="primary" size="lg" href="/launch" iconRight={<IconArrowRight size={16} />}>
        Launch
      </Button>
    </div>
  </section>
);

/** Tabs by ranking, then the cards. Sort lives in the URL so a tab survives a refresh and a share. */
export const Feed = () => {
  const [params, setParams] = useSearchParams();
  const raw = params.get("sort");
  const sort: AppSort = isSort(raw) ? raw : "trending";
  const apps = useApps(sort);
  const stats = useStats();
  const items = useMemo(() => flatPages(apps.data?.pages), [apps.data]);
  // Twelve rows keep the page scannable (and the loop explainer reachable for
  // a signed-out visitor); "more" reveals what is loaded before fetching more.
  const [shown, setShown] = useState(PAGE_STEP);
  useEffect(() => setShown(PAGE_STEP), [sort]);
  const visible = items.slice(0, shown);
  const canShowMore = shown < items.length || apps.hasNextPage;
  const more = () => {
    if (shown < items.length) setShown((n) => n + PAGE_STEP);
    else void apps.fetchNextPage().then(() => setShown((n) => n + PAGE_STEP));
  };

  const tabs = useMemo<TabItem<AppSort>[]>(
    () => SORTS.map((s) => ({ id: s.id, label: s.label, count: stats.data ? stats.data.counts[s.id] : undefined })),
    [stats.data],
  );

  return (
    <section aria-label="Ranked feed" className="min-w-0">
      <Tabs
        name="feed"
        items={tabs}
        value={sort}
        onChange={(id) => setParams(id === "trending" ? {} : { sort: id }, { replace: true })}
        className="-mx-4 px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0"
      />
      <div id={panelId("feed", sort)} role="tabpanel" aria-labelledby={`feed-tab-${sort}`} className="mt-4">
        {apps.isPending ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3" aria-busy>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[196px] w-full" rounded="card" />
            ))}
          </div>
        ) : apps.isError ? (
          <EmptyState
            title="the feed did not load"
            body={apps.error.message}
            action={
              <Button variant="secondary" size="sm" onClick={() => void apps.refetch()}>
                retry
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={EMPTY_COPY[sort].title}
            body={EMPTY_COPY[sort].body}
            action={
              <Button variant="primary" size="sm" href="/launch">
                launch a coin
              </Button>
            }
          />
        ) : (
          <>
            <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 2xl:grid-cols-3">
              {visible.map((app, i) => (
                <li key={app.id}>
                  <CoinCard app={app} rank={i + 1} />
                </li>
              ))}
            </ul>
            {canShowMore && (
              <div className="mt-4 flex justify-center">
                <Button variant="secondary" size="sm" loading={apps.isFetchingNextPage} onClick={more}>
                  more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
