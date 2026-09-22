import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { AppDetailDto, CandleIntervalDto } from "@pyre/shared";
import { CandleIntervalDto as CandleInterval } from "@pyre/shared";
import { useApp, useStats } from "../../api/queries.js";
import { isHttpError } from "../../api/client.js";
import { Chart, type ChartMarker } from "../../components/Chart.js";
import { EmptyState, Skeleton, Tabs, panelId, tabId, useMediaQuery } from "../../ui/index.js";
import { CoinHeader } from "./CoinHeader.js";
import { FeeTable } from "./FeeTable.js";
import { LoopStatus } from "./LoopStatus.js";
import { ReportSheet, ShareSheet } from "./Sheets.js";
import { StatsAudit } from "./StatsAudit.js";
import { GraduationCard } from "./SupplyCards.js";
import { MobileTradeBar, TradePanel } from "./TradePanel.js";
import { flatFeed, useAppStream, useCandles, useFeed, useHolders, useTrades } from "./queries.js";
import { AppTab } from "./tabs/AppTab.js";
import { BountiesTab } from "./tabs/BountiesTab.js";
import { HoldersTab } from "./tabs/HoldersTab.js";
import { RoadmapTab } from "./tabs/RoadmapTab.js";
import { ThreadTab } from "./tabs/ThreadTab.js";
import { TradesTab, mergeTrades } from "./tabs/TradesTab.js";
import { BuildLogTab } from "./tabs/BuildLogTab.js";

const TABS = [
  { id: "build", label: "Build log" },
  { id: "app", label: "App" },
  { id: "holders", label: "Holders" },
  { id: "trades", label: "Trades" },
  { id: "thread", label: "Thread" },
  { id: "roadmap", label: "Roadmap" },
  { id: "bounties", label: "Bounties" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const TAB_IDS: Record<string, true> = Object.fromEntries(TABS.map((t) => [t.id, true]));

const INTERVALS = CandleInterval.options;
const isInterval = (v: string | null): v is CandleIntervalDto => !!v && (INTERVALS as readonly string[]).includes(v);

const NAME = "coin";

/** `/c/:slug` */
export const CoinPage = () => {
  const { slug = "" } = useParams<{ slug: string }>();
  const app = useApp(slug);
  useEffect(() => {
    document.title = app.data ? `$${app.data.ticker} · ${app.data.name} — Pyre` : "Pyre";
  }, [app.data]);

  if (app.isPending) return <PageSkeleton />;
  if (app.isError) {
    const notFound = isHttpError(app.error) && app.error.status === 404;
    return (
      <div className="mx-auto max-w-2xl py-16">
        <EmptyState
          variant={notFound ? "ash" : "default"}
          title={notFound ? "No such coin" : "Could not load this coin"}
          body={notFound ? `Nothing lives at /c/${slug}. It may have been renamed or never launched.` : app.error.message}
        />
      </div>
    );
  }
  return <Loaded app={app.data} />;
};

const PageSkeleton = () => (
  <div className="space-y-6" role="status" aria-label="Loading coin">
    <div className="flex items-center gap-4">
      <Skeleton className="h-16 w-16" rounded="pill" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
    </div>
    <Skeleton className="h-16 w-64" />
    <Skeleton className="h-[360px] w-full" rounded="card" />
    <Skeleton className="h-40 w-full" rounded="card" />
  </div>
);

const Loaded = ({ app }: { app: AppDetailDto }) => {
  const [params, setParams] = useSearchParams();
  // Below `lg` the rail folds under the content and the trade panel moves to the sticky bar.
  const mobile = useMediaQuery("(max-width: 1023px)");
  const stats = useStats();
  const ethPriceUsd = stats.data?.ethPriceUsd ?? 0;

  const tabParam = params.get("tab");
  const tab: TabId = tabParam && TAB_IDS[tabParam] ? (tabParam as TabId) : "build";
  const setTab = (id: TabId) => {
    const next = new URLSearchParams(params);
    if (id === "build") next.delete("tab");
    else next.set("tab", id);
    setParams(next, { replace: true });
  };

  const [interval, setInterval] = useState<CandleIntervalDto>(() => (isInterval(params.get("i")) ? (params.get("i") as CandleIntervalDto) : "15m"));
  const candles = useCandles(app.slug, interval);
  const feed = useFeed(app.slug);
  const trades = useTrades(app.slug);
  const holders = useHolders(app.slug);
  const live = useAppStream(app.slug, app.phase);
  const [sheet, setSheet] = useState<"share" | "report" | null>(null);

  const events = useMemo(() => flatFeed(feed.data), [feed.data]);
  const tradeRows = useMemo(() => trades.data?.pages.flatMap((p) => p.items), [trades.data]);
  const allTrades = useMemo(() => mergeTrades(live.liveTrades, tradeRows ?? []), [live.liveTrades, tradeRows]);
  const markers = useMemo<ChartMarker[]>(() => {
    const out: ChartMarker[] = [];
    for (const e of events) if (e.payload.type === "DEPLOY") out.push({ t: Math.floor(new Date(e.createdAt).getTime() / 1000), kind: "deploy", label: `v${e.payload.version}` });
    return out;
  }, [events]);

  const trade = <TradePanel app={app} ethPriceUsd={ethPriceUsd} />;

  return (
    <div className="flex flex-col gap-6 pb-24 lg:pb-0">
      <CoinHeader app={app} onShare={() => setSheet("share")} onReport={() => setSheet("report")} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <Chart
            candles={candles.data?.candles}
            interval={interval}
            onIntervalChange={(i) => {
              if (isInterval(i)) setInterval(i);
            }}
            intervals={INTERVALS}
            mode="mcap"
            unit="usd"
            markers={markers}
            ethPriceUsd={ethPriceUsd}
            supply={candles.data?.supply ?? 1_000_000_000}
            height={mobile ? 280 : 380}
          />

          {mobile && <GraduationCard app={app} />}

          <LoopStatus app={app} />

          <section aria-label="Coin details">
            <Tabs items={TABS} value={tab} onChange={setTab} name={NAME} size="sm" />
            <div id={panelId(NAME, tab)} role="tabpanel" aria-labelledby={tabId(NAME, tab)} className="pt-4">
              {tab === "build" && (
                <BuildLogTab app={app} events={events} stream={live.stream} hasMore={!!feed.hasNextPage} loadingMore={feed.isFetchingNextPage} onLoadMore={() => void feed.fetchNextPage()} />
              )}
              {tab === "app" && <AppTab app={app} events={events} />}
              {tab === "holders" && <HoldersTab app={app} data={holders.data} />}
              {tab === "trades" && (
                <TradesTab
                  app={app}
                  rows={tradeRows}
                  live={live.liveTrades}
                  ethPriceUsd={ethPriceUsd}
                  hasMore={!!trades.hasNextPage}
                  loadingMore={trades.isFetchingNextPage}
                  onLoadMore={() => void trades.fetchNextPage()}
                />
              )}
              {tab === "thread" && <ThreadTab app={app} events={events} hasMore={!!feed.hasNextPage} loadingMore={feed.isFetchingNextPage} onLoadMore={() => void feed.fetchNextPage()} />}
              {tab === "roadmap" && <RoadmapTab app={app} />}
              {tab === "bounties" && <BountiesTab app={app} />}
            </div>
          </section>

          {mobile && (
            <>
              <StatsAudit app={app} trades={allTrades} holders={holders.data?.holders ?? []} ethPriceUsd={ethPriceUsd} />
              <FeeTable app={app} />
            </>
          )}
        </div>

        {!mobile && (
          <aside className="sticky top-20 flex flex-col gap-4" aria-label="Trade and audit">
            {trade}
            <GraduationCard app={app} />
            <StatsAudit app={app} trades={allTrades} holders={holders.data?.holders ?? []} ethPriceUsd={ethPriceUsd} />
            <FeeTable app={app} />
          </aside>
        )}
      </div>

      {mobile && <MobileTradeBar app={app} ethPriceUsd={ethPriceUsd} />}
      <ShareSheet app={app} open={sheet === "share"} onClose={() => setSheet(null)} />
      <ReportSheet app={app} open={sheet === "report"} onClose={() => setSheet(null)} />
    </div>
  );
};
