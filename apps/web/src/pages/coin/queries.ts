import { useCallback, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  BuildEventType,
  type BountyDto,
  type BuildEventDto,
  type CandleIntervalDto,
  type CandlesDto,
  type CoinBurnsPageDto,
  type HolderDto,
  type QueueItemDto,
  type TradeBody,
  type TradeDto,
  type TradeQuoteDto,
  type TradeResultDto,
} from "@pyre/shared";
import { api, qs } from "../../api/client.js";
import { keys as shared } from "../../api/queries.js";
import { useSse, type SseState } from "../../api/sse.js";
import type { Page } from "../../api/types.js";

/*
 * Coin-page data. Every hook here is keyed on the slug and owns its own
 * refetch policy; the SSE hook at the bottom feeds live frames into these
 * caches so a trade or a deploy shows up without a refetch.
 */

export const keys = {
  feed: (slug: string) => ["coin", slug, "feed"] as const,
  candles: (slug: string, interval: CandleIntervalDto) => ["coin", slug, "candles", interval] as const,
  trades: (slug: string) => ["coin", slug, "trades"] as const,
  holders: (slug: string) => ["coin", slug, "holders"] as const,
  roadmap: (slug: string) => ["coin", slug, "roadmap"] as const,
  bounties: (slug: string) => ["coin", slug, "bounties"] as const,
  burns: (slug: string) => ["coin", slug, "burns"] as const,
};

export interface FeedPage {
  events: BuildEventDto[];
  nextCursor: string | null;
}

export interface HoldersDto {
  holders: HolderDto[];
  supplyUnits: string;
}

export interface RoadmapDto {
  items: QueueItemDto[];
  minHoldUnits: string;
  canSubmit: boolean;
  myWeightUnits: string;
}

/** Build log + chain events, newest first per page; the console reverses into reading order. */
export const useFeed = (slug: string) =>
  useInfiniteQuery({
    queryKey: keys.feed(slug),
    queryFn: ({ pageParam, signal }) => api.get<FeedPage>(`/v1/apps/${slug}/feed${qs({ cursor: pageParam, limit: 200 })}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 60_000,
  });

export const useCandles = (slug: string, interval: CandleIntervalDto) =>
  useQuery({
    queryKey: keys.candles(slug, interval),
    queryFn: ({ signal }) => api.get<CandlesDto>(`/v1/apps/${slug}/candles${qs({ interval })}`, signal),
    refetchInterval: interval === "1m" ? 15_000 : 60_000,
    placeholderData: (prev) => prev,
  });

export const useTrades = (slug: string) =>
  useInfiniteQuery({
    queryKey: keys.trades(slug),
    queryFn: ({ pageParam, signal }) => api.get<Page<TradeDto>>(`/v1/apps/${slug}/trades${qs({ cursor: pageParam, limit: 100 })}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 30_000,
  });

/** Coin buy-and-burns (Solana apps): the 25% fee leg that burns the coin itself, newest first. */
export const useCoinBurns = (slug: string, enabled: boolean) =>
  useInfiniteQuery({
    queryKey: keys.burns(slug),
    queryFn: ({ pageParam, signal }) => api.get<CoinBurnsPageDto>(`/v1/apps/${slug}/burns${qs({ cursor: pageParam, limit: 50 })}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    refetchInterval: 60_000,
  });

export const useHolders = (slug: string) =>
  useQuery({
    queryKey: keys.holders(slug),
    queryFn: ({ signal }) => api.get<HoldersDto>(`/v1/apps/${slug}/holders${qs({ limit: 100 })}`, signal),
    refetchInterval: 60_000,
  });

export const useRoadmap = (slug: string) =>
  useQuery({
    queryKey: keys.roadmap(slug),
    queryFn: ({ signal }) => api.get<RoadmapDto>(`/v1/apps/${slug}/proposals`, signal),
    staleTime: 30_000,
  });

export const useBounties = (slug: string) =>
  useQuery({
    queryKey: keys.bounties(slug),
    queryFn: ({ signal }) => api.get<{ items: BountyDto[] }>(`/v1/apps/${slug}/bounties`, signal),
    staleTime: 30_000,
  });

/* ─────────── mutations ─────────── */

export const useSubmitPrompt = (slug: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.post<QueueItemDto>(`/v1/apps/${slug}/proposals`, { text }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.roadmap(slug) }),
  });
};

export const useVotePrompt = (slug: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.post<QueueItemDto>(`/v1/queue/${itemId}/vote`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.roadmap(slug) }),
  });
};

export const useCreateBounty = (slug: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; description: string; eth: number }) => api.post<BountyDto>(`/v1/apps/${slug}/bounties`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.bounties(slug) }),
  });
};

export const useClaimBounty = (slug: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, prNumber }: { id: string; prNumber: number }) => api.post<BountyDto>(`/v1/bounties/${id}/claim`, { prNumber }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.bounties(slug) }),
  });
};

export interface ReportBody {
  slug: string;
  reporter: string;
  kind: "ABUSE" | "DMCA" | "IMPERSONATION" | "OTHER";
  details: string;
}

export const useReport = () => useMutation({ mutationFn: (body: ReportBody) => api.post<{ id: string }>("/v1/reports", body) });

/** Server-side quote for the custodial wallet (includes the snipe tax keyed to that recipient). */
export const useCustodialQuote = () => useMutation({ mutationFn: (body: TradeBody) => api.post<TradeQuoteDto>("/v1/me/quote", body) });

export const useCustodialTrade = (slug: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TradeBody) => api.post<TradeResultDto>("/v1/me/trade", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: shared.app(slug) });
      void qc.invalidateQueries({ queryKey: shared.me });
      void qc.invalidateQueries({ queryKey: keys.trades(slug) });
      void qc.invalidateQueries({ queryKey: keys.holders(slug) });
    },
  });
};

/* ─────────── live stream ─────────── */

const STREAM_EVENTS = BuildEventType.options;

export interface LiveState {
  stream: SseState;
  /** Trades seen on the stream before the REST page caught up; prepended to the tape. */
  liveTrades: ReadonlyArray<TradeDto>;
}

/**
 * `/v1/apps/:slug/feed/stream`. Appends every frame to the feed cache and
 * fans the chain events out: TRADE → tape, DEPLOY / FEES / GRADUATED / LAUNCH
 * → app detail refetch.
 */
export const useAppStream = (slug: string, phase: number): LiveState => {
  const qc = useQueryClient();
  const [liveTrades, setLiveTrades] = useState<ReadonlyArray<TradeDto>>([]);

  const onMessage = useCallback(
    (event: BuildEventDto) => {
      qc.setQueryData<InfiniteData<FeedPage, string | null>>(keys.feed(slug), (cur) => {
        if (!cur) return cur;
        const first = cur.pages[0];
        if (!first || first.events.some((e) => e.id === event.id)) return cur;
        return { ...cur, pages: [{ ...first, events: [event, ...first.events] }, ...cur.pages.slice(1)] };
      });
      const p = event.payload;
      switch (p.type) {
        case "TRADE": {
          const trade: TradeDto = {
            id: event.id,
            appId: event.appId,
            side: p.side,
            venue: phase >= 2 ? "POOL" : "CURVE",
            wallet: p.wallet,
            tokenUnits: p.tokenUnits,
            quoteWei: p.quoteWei,
            priceUsd: p.priceUsd,
            txHash: p.txHash,
            block: 0,
            ts: event.createdAt,
          };
          setLiveTrades((cur) => (cur.some((t) => t.txHash === trade.txHash) ? cur : [trade, ...cur].slice(0, 200)));
          void qc.invalidateQueries({ queryKey: shared.app(slug) });
          break;
        }
        case "DEPLOY":
        case "FEES":
        case "GRADUATED":
        case "LAUNCH":
        case "JOB_FINISHED":
        case "JOB_FAILED":
        case "JOB_STARTED":
        case "DORMANT":
        case "REVIVED":
        case "BUDGET":
          void qc.invalidateQueries({ queryKey: shared.app(slug) });
          break;
        case "PR_MERGED":
        case "BOUNTY_CLAIMED":
          void qc.invalidateQueries({ queryKey: keys.bounties(slug) });
          break;
        default:
          break;
      }
    },
    [qc, slug, phase],
  );

  const stream = useSse<BuildEventDto>(`/v1/apps/${slug}/feed/stream`, { onMessage, events: STREAM_EVENTS });
  return { stream, liveTrades };
};

/** Every event across the fetched feed pages, oldest first. */
export const flatFeed = (data: InfiniteData<FeedPage> | undefined): BuildEventDto[] => {
  if (!data) return [];
  const all = data.pages.flatMap((p) => p.events);
  all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return all;
};
