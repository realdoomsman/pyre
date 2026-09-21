import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { AppDetailDto, AppSort, AppSummaryDto, AppsPageDto, BurnsPageDto, MeDto, StatsDto } from "@pyre/shared";
import { api, getSessionToken, qs } from "./client.js";
import type { GlobalFrame, StatusDto } from "./types.js";
import { useSse } from "./sse.js";

/*
 * Shared hooks: the queries more than one page reads. Page-specific data
 * (candles, feed, proposals, admin) lives with its page so each owner sets its
 * own refetch policy.
 */

export const keys = {
  stats: ["stats"] as const,
  apps: (sort: AppSort) => ["apps", sort] as const,
  appSearch: (q: string) => ["apps", "search", q] as const,
  app: (slug: string) => ["app", slug] as const,
  burns: ["burns"] as const,
  me: ["me"] as const,
  status: ["status"] as const,
};

export const useStats = () =>
  useQuery({ queryKey: keys.stats, queryFn: ({ signal }) => api.get<StatsDto>("/v1/stats", signal), refetchInterval: 30_000 });

export const useApps = (sort: AppSort) =>
  useInfiniteQuery({
    queryKey: keys.apps(sort),
    queryFn: ({ pageParam, signal }) => api.get<AppsPageDto>(`/v1/apps${qs({ sort, cursor: pageParam, limit: 30 })}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 20_000,
  });

/** `GET /v1/apps?q=` — name / ticker / slug / token address substring; empty query → no request. */
export const useAppSearch = (q: string) =>
  useQuery({
    queryKey: keys.appSearch(q),
    queryFn: ({ signal }) => api.get<AppsPageDto>(`/v1/apps${qs({ q, limit: 20 })}`, signal),
    enabled: q.trim().length > 0,
    staleTime: 30_000,
    select: (page) => page.items,
  });

export const useApp = (slug: string | undefined) =>
  useQuery({
    queryKey: keys.app(slug ?? ""),
    queryFn: ({ signal }) => api.get<AppDetailDto>(`/v1/apps/${slug}`, signal),
    enabled: !!slug,
    refetchInterval: 15_000,
  });

export const useBurns = () =>
  useInfiniteQuery({
    queryKey: keys.burns,
    queryFn: ({ pageParam, signal }) => api.get<BurnsPageDto>(`/v1/burns${qs({ cursor: pageParam, limit: 50 })}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 30_000,
  });

/** The signed-in user. Disabled without a stored session so it never 401s on a cold visit. */
export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => api.get<MeDto>("/v1/me", signal),
    enabled: !!getSessionToken(),
    staleTime: 15_000,
  });

export const useStatus = () =>
  useQuery({ queryKey: keys.status, queryFn: ({ signal }) => api.get<StatusDto>("/v1/status", signal), refetchInterval: 15_000 });

/**
 * `/v1/apps/stream`: every frame names an app whose ranking inputs changed.
 * Invalidates the lists and that app's detail, and hands the frame to `onFrame`
 * for consumers that render it (the live tape, the build hero, the proof strip).
 */
export const useGlobalStream = (onFrame?: (frame: GlobalFrame) => void, enabled = true) => {
  const qc = useQueryClient();
  const onMessage = useCallback(
    (frame: GlobalFrame) => {
      onFrame?.(frame);
      void qc.invalidateQueries({ queryKey: ["apps"] });
      if (frame.slug) void qc.invalidateQueries({ queryKey: keys.app(frame.slug) });
      const t = frame.event?.payload.type;
      if (t === "BUYBACK" || t === "FEES" || t === "DEPLOY" || t === "JOB_FINISHED" || t === "GRADUATED") {
        void qc.invalidateQueries({ queryKey: keys.stats });
        if (t === "BUYBACK") void qc.invalidateQueries({ queryKey: keys.burns });
      }
    },
    [qc, onFrame],
  );
  return useSse<GlobalFrame>("/v1/apps/stream", { onMessage, enabled });
};

/** Rows of every fetched page, flattened. */
export const flatPages = <T>(pages: ReadonlyArray<{ items: T[] }> | undefined): T[] => (pages ? pages.flatMap((p) => p.items) : []);

export type { AppSummaryDto };
