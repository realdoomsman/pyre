import { useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { AgentState, AppSummaryDto, CandlesDto } from "@pyre/shared";
import { api } from "../api/client.js";
import { formatUsdCompact, timeAgo } from "../lib/format.js";
import { useWatchlist } from "../lib/watchlist.js";
import { Avatar, Button, Card, Chip, GraduationRing, HeatGauge, Sparkline, TickFlash, cx, type ChipTone } from "../ui/index.js";
import { Delta } from "./Money.js";
import { IconEye } from "./icons.js";

export const AGENT_CHIP: Record<AgentState, { label: string; tone: ChipTone; dot: boolean }> = {
  idle: { label: "idle", tone: "neutral", dot: false },
  building: { label: "building", tone: "build", dot: true },
  reviewing: { label: "reviewing", tone: "accent", dot: true },
  deploying: { label: "deploying", tone: "build", dot: true },
  dormant: { label: "dormant", tone: "neutral", dot: false },
};

export interface CoinCardProps {
  app: AppSummaryDto;
  rank?: number;
  /** Override the trade action (default: the coin page with the buy panel open). */
  onTrade?: (app: AppSummaryDto) => void;
  className?: string;
}

/** 24 hourly closes, fetched the first time the card is hovered or focused. */
const useHoverSpark = (slug: string, on: boolean) =>
  useQuery({
    queryKey: ["candles", slug, "1h", "spark"],
    queryFn: ({ signal }) => api.get<CandlesDto>(`/v1/apps/${slug}/candles?interval=1h&limit=24`, signal),
    enabled: on,
    staleTime: 5 * 60_000,
    select: (d) => d.candles.map((c) => c.c),
  });

/**
 * Feed card. Avatar in the graduation ring, ticker + name + age, market cap
 * that flashes on tick, 24h delta, fees routed to the agent, heat index, the
 * agent's state, and a sparkline that appears on hover. Dormant apps go ash.
 */
export const CoinCard = ({ app, rank, onTrade, className }: CoinCardProps) => {
  const navigate = useNavigate();
  const { has, toggle } = useWatchlist();
  const [hover, setHover] = useState(false);
  const spark = useHoverSpark(app.slug, hover);
  const dormant = app.agentState === "dormant" || app.status === "DORMANT" || app.status === "KILLED";
  const agent = AGENT_CHIP[app.agentState];
  const watched = has(app.slug);
  const graduated = app.phase === 2 || app.phase === 3;

  const trade = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onTrade) onTrade(app);
    else void navigate(`/c/${app.slug}?trade=buy`);
  };
  const watch = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    toggle(app.slug);
  };

  return (
    <Card
      as="article"
      padding={0}
      interactive
      ash={dormant}
      className={cx("group relative", className)}
      onMouseEnter={() => setHover(true)}
      onFocus={() => setHover(true)}
      aria-label={`${app.name} ($${app.ticker})`}
    >
      <Link to={`/c/${app.slug}`} className="block p-4 outline-none">
        <div className="flex items-start gap-3">
          {rank !== undefined && <span className="num w-5 shrink-0 pt-2 text-12 text-ink-3">{rank}</span>}
          <GraduationRing progress={app.progress} graduated={graduated} size={48}>
            <Avatar src={app.imageUrl} name={app.ticker} size={40} shape="circle" />
          </GraduationRing>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="num text-14 font-medium text-ink">${app.ticker}</span>
              <span className="truncate text-13 text-ink-2">{app.name}</span>
              <span className="num ml-auto shrink-0 text-12 text-ink-3" title={new Date(app.createdAt).toLocaleString()}>
                {timeAgo(app.launchedAt ?? app.createdAt)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-13 text-ink-3">{app.oneLiner}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-3">
          <div>
            <div className="eyebrow">market cap</div>
            <div className="flex items-baseline gap-2">
              <TickFlash value={app.mcapUsd} className="figure figure-md -mx-1 px-1 text-ink">
                {formatUsdCompact(Math.round(app.mcapUsd * 1e6))}
              </TickFlash>
              <Delta pct={app.change24hPct} className="text-12" />
            </div>
          </div>
          <div className="h-6 w-[72px]">
            {hover && spark.data && spark.data.length > 1 ? (
              <Sparkline data={spark.data} width={72} height={24} className="animate-fade-in" />
            ) : (
              <span className="block h-6 w-[72px]" aria-hidden />
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-12">
          <span className="text-ink-3">
            fees → agent <span className="num text-ink-2">{formatUsdCompact(app.budgetMicros)}</span>
          </span>
          <span className="text-ink-3">
            burned <span className="num text-burn">{app.burnedPct.toFixed(app.burnedPct >= 10 ? 1 : 2)}%</span>
          </span>
          <HeatGauge value={app.heat} size={44} label={`heat index ${Math.round(app.heat * 100)}`} className="ml-auto" />
        </div>
      </Link>

      <div className="flex items-center gap-2 border-t border-line px-4 py-2">
        <Chip tone={agent.tone} dot={agent.dot} size="sm" mono>
          {agent.label}
        </Chip>
        {app.liveUrl && (
          <a href={app.liveUrl} target="_blank" rel="noreferrer noopener" className="num text-12 text-ink-3 hover:text-ink">
            v{app.liveVersion}
          </a>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="icon" size="sm" label={watched ? `Stop watching $${app.ticker}` : `Watch $${app.ticker}`} aria-pressed={watched} onClick={watch}>
            <IconEye size={15} className={watched ? "text-accent" : undefined} />
          </Button>
          <Button variant="secondary" size="sm" onClick={trade} disabled={!app.tokenAddress}>
            Trade
          </Button>
        </span>
      </div>
    </Card>
  );
};
