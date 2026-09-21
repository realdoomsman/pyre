import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { big, dec, prisma, type Prisma } from "@pyre/db";
import { getEthPriceUsd, transferEth } from "@pyre/chain";
import {
  AppSort,
  AppSpec,
  CandleIntervalDto,
  FEE_SPLIT_BPS,
  PONS_GRADUATION_THRESHOLD_WEI,
  REVENUE_SPLIT_BPS,
  TopupBody,
  ethToWei,
  usdMicrosFromWei,
  type AppDetailDto,
  type AppSummaryDto,
  type AppsPageDto,
  type CandlesDto,
} from "@pyre/shared";
import { optionalAuth, requireAuth } from "../lib/auth.js";
import { APPS_TAG, appTag, cacheKey, cached } from "../lib/cache.js";
import { custodialAccount, custodialEthBalance, GAS_RESERVE_WEI } from "../lib/custodial.js";
import {
  APP_SUMMARY_SELECT,
  BUYBACK_INCLUDE,
  USER_REF_SELECT,
  appExtrasByApp,
  appSummary,
  buybackDto,
  candleDto,
  eventDto,
  feeEventDto,
  holderDto,
  jobDto,
  queueItemDto,
  tokens,
  tradeDto,
  usd,
  userRef,
  type AppExtras,
  type AppSummaryRow,
} from "../lib/dto.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { GLOBAL_FEED_CHANNEL, publishEvent, publishGlobal } from "../lib/events.js";
import { pageQuery, sendCached, sizeQuery } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { db, sseConnections } from "../lib/metrics.js";
import { subscribeChannel } from "../lib/redis.js";
import { SUPPLY_BASE_UNITS } from "../lib/votes.js";
import { feedStream } from "./feed-stream.js";

export const apps = Router();

const DAY_MS = 86_400_000;

/** Statuses visible on the public feed — and only once a token is actually linked. */
const PUBLIC: Prisma.AppWhereInput = { status: { in: ["LIVE", "DORMANT"] }, tokenAddress: { not: null } };

const since24h = () => new Date(Date.now() - DAY_MS);

/**
 * Feed filters. `where` narrows the set; `orderBy` ranks it in the database when the ranking
 * inputs are columns. Trending and burning rank on 24h aggregates instead, so they load the
 * candidate set and sort in memory (`rank`), paging by offset.
 */
interface RankInputs {
  extras: AppExtras;
  burned24hWei: bigint;
  ethPriceUsd: number;
}

const FILTERS: Record<AppSort, { where: () => Prisma.AppWhereInput; orderBy?: Prisma.AppOrderByWithRelationInput[]; rank?: (a: AppSummaryDto, r: RankInputs) => number }> = {
  /** 24h volume + 3× 24h revenue + 2× 24h fees (USD): what is actually moving through the loop. */
  trending: {
    where: () => PUBLIC,
    rank: (a, r) => a.volume24hUsd + 3 * usd(r.extras.revenue24hMicros) + 2 * tokens(r.extras.fees24hWei) * r.ethPriceUsd + 100 * a.heat,
  },
  new: { where: () => PUBLIC, orderBy: [{ launchedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }] },
  heating: { where: () => ({ ...PUBLIC, launchPhase: 0 }), orderBy: [{ progress: "desc" }, { volume24hUsd: "desc" }, { id: "desc" }] },
  graduated: { where: () => ({ ...PUBLIC, launchPhase: 2 }), orderBy: [{ graduatedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }] },
  shipping: { where: () => ({ ...PUBLIC, deployments: { some: { createdAt: { gte: since24h() } } } }), orderBy: [{ updatedAt: "desc" }, { id: "desc" }] },
  burning: {
    where: () => ({ ...PUBLIC, buybacks: { some: { status: "BURNED", completedAt: { gte: since24h() } } } }),
    rank: (_a, r) => Number(r.burned24hWei),
  },
  revenue: { where: () => ({ ...PUBLIC, revenueMicros: { gt: 0n } }), orderBy: [{ revenueMicros: "desc" }, { id: "desc" }] },
};

/** In-memory ranked sorts load at most this many candidates. */
const RANK_WINDOW = 500;

/** Offset cursor for in-memory ranked sorts ("o:<n>"); DB sorts use the last row id. */
const offsetOf = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  const m = /^offset_(\d{1,8})$/.exec(cursor);
  if (!m) throw new HttpError(400, "malformed_cursor");
  return Number(m[1]);
};

const ListQuery = pageQuery(24, 100).extend({ sort: AppSort.default("trending"), q: z.string().trim().min(1).max(64).optional() });

const burned24hByApp = async (appIds: string[]): Promise<Record<string, bigint>> => {
  const out: Record<string, bigint> = {};
  if (appIds.length === 0) return out;
  const rows = await db.buyback.groupBy({
    by: ["appId"],
    where: { appId: { in: appIds }, status: "BURNED", completedAt: { gte: since24h() } },
    _sum: { ethWei: true },
  });
  for (const r of rows) out[r.appId] = big(r._sum.ethWei);
  return out;
};

const summarize = async (rows: AppSummaryRow[]): Promise<{ items: AppSummaryDto[]; extras: Record<string, AppExtras>; ethPriceUsd: number }> => {
  const [extras, ethPriceUsd] = await Promise.all([appExtrasByApp(rows.map((a) => a.id)), getEthPriceUsd()]);
  return { items: rows.map((a) => appSummary(a, extras[a.id]!, ethPriceUsd)), extras, ethPriceUsd };
};

const listApps = async (q: z.infer<typeof ListQuery>): Promise<AppsPageDto> => {
  const filter = FILTERS[q.sort];
  if (filter.rank) {
    const offset = offsetOf(q.cursor);
    const rows = await db.app.findMany({ where: filter.where(), orderBy: [{ updatedAt: "desc" }], take: RANK_WINDOW, select: APP_SUMMARY_SELECT });
    const [{ items, extras, ethPriceUsd }, burned] = await Promise.all([summarize(rows), q.sort === "burning" ? burned24hByApp(rows.map((a) => a.id)) : Promise.resolve<Record<string, bigint>>({})]);
    const rank = filter.rank;
    const scored = items
      .map((a) => ({ a, s: rank(a, { extras: extras[a.id]!, burned24hWei: burned[a.id] ?? 0n, ethPriceUsd }) }))
      .sort((x, y) => y.s - x.s || x.a.id.localeCompare(y.a.id));
    const page = scored.slice(offset, offset + q.limit).map((x) => x.a);
    return { items: page, nextCursor: offset + q.limit < scored.length ? `offset_${offset + q.limit}` : null };
  }
  const rows = await db.app.findMany({
    where: filter.where(),
    orderBy: filter.orderBy,
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: APP_SUMMARY_SELECT,
  });
  const page = rows.slice(0, q.limit);
  const { items } = await summarize(page);
  return { items, nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
};

/** Total rows per sort — the tab counts on the home feed. */
export const listCounts = async (): Promise<Record<AppSort, number>> => {
  const sorts = AppSort.options;
  const counts = await Promise.all(sorts.map((s) => db.app.count({ where: FILTERS[s].where() })));
  const out = {} as Record<AppSort, number>;
  sorts.forEach((s, i) => (out[s] = counts[i]!));
  return out;
};

apps.get(
  "/",
  wrap(async (req, res) => {
    const q = parse(ListQuery, req.query);
    if (q.q) {
      const needle = q.q;
      const rows = await db.app.findMany({
        where: {
          ...PUBLIC,
          OR: [
            { name: { contains: needle, mode: "insensitive" } },
            { ticker: { contains: needle, mode: "insensitive" } },
            { slug: { contains: needle, mode: "insensitive" } },
            { tokenAddress: { equals: needle, mode: "insensitive" } },
          ],
        },
        orderBy: [{ revenueMicros: "desc" }, { marketCapUsd: "desc" }],
        take: 20,
        select: APP_SUMMARY_SELECT,
      });
      const { items } = await summarize(rows);
      sendCached(res, { items, nextCursor: null } satisfies AppsPageDto, { maxAge: 10, swr: 60 });
      return;
    }
    const payload = await cached(cacheKey("apps.list", { sort: q.sort, cursor: q.cursor ?? null, limit: q.limit }), 10_000, () => listApps(q), [APPS_TAG]);
    sendCached(res, payload, { maxAge: 10, swr: 60 });
  }),
);

const APP_IDENTITY_SELECT = { id: true, slug: true, ticker: true, name: true } as const;

/** SSE of `feed:*global*`, each frame labelled with the app so the live tape needs no lookup. */
apps.get("/stream", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");
  sseConnections.add({ stream: "global" }, 1);
  const unsubscribe = subscribeChannel(GLOBAL_FEED_CHANNEL, (message) => {
    let parsed: { appId?: unknown; type?: unknown; event?: unknown };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof parsed.appId !== "string") return;
    const appId = parsed.appId;
    cached(cacheKey("apps.identity", { appId }), 60_000, () => db.app.findUnique({ where: { id: appId }, select: APP_IDENTITY_SELECT }))
      .then((app) => {
        if (!app || res.writableEnded) return;
        const frame = { appId, slug: app.slug, ticker: app.ticker, name: app.name, type: typeof parsed.type === "string" ? parsed.type : "UPDATE", event: parsed.event };
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      })
      .catch((err: unknown) => logger.warn({ err, appId }, "global stream frame dropped"));
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    sseConnections.add({ stream: "global" }, -1);
  });
});

/** Slug lookup for routes that only need the app's identity; a coin is public only once its token exists. */
const appBySlug = async (slug: string) => {
  const app = await db.app.findUnique({
    where: { slug },
    select: { id: true, tokenAddress: true, curveAddress: true, launchPhase: true, burnedTokens: true, launcher: { select: { wallet: true } } },
  });
  if (!app || !app.tokenAddress) throw new HttpError(404, "app_not_found");
  return app;
};

/** Every column the coin-detail response reads — no `Bytes` column, no unused metadata. */
const APP_DETAIL_SELECT = {
  ...APP_SUMMARY_SELECT,
  prompt: true,
  launcherId: true,
  killedReason: true,
  walletAddress: true,
  stakeWei: true,
  stakeTx: true,
  stakeRefundTx: true,
  launchTx: true,
  spentMicros: true,
  usersCount: true,
  uptimeBps: true,
  healthy: true,
  unsweptWei: true,
  escrowWei: true,
  twitterUrl: true,
  websiteUrl: true,
  xAccount: true,
  repoUrl: true,
  milestones: true,
  maintainer: { select: USER_REF_SELECT },
  forkOf: { select: { id: true, slug: true, name: true, ticker: true } },
  _count: { select: { forks: true } },
} as const;

/**
 * Public half of the coin page: the app row, then one batched transaction for every dependent
 * list. Viewer-specific fields are layered on afterwards so this payload stays cacheable.
 */
const loadAppDetail = async (slug: string) => {
  const app = await db.app.findUnique({ where: { slug }, select: APP_DETAIL_SELECT });
  if (!app || !app.tokenAddress) throw new HttpError(404, "app_not_found");
  const [fees, lastBuild, lastBuyback, lastEvent, roadmapCounts, top, bountyOpen] = await db.$transaction([
    db.feeEvent.findMany({ where: { appId: app.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    db.buildJob.findFirst({ where: { appId: app.id, status: { in: ["SUCCEEDED", "FAILED", "RUNNING"] } }, orderBy: { createdAt: "desc" } }),
    db.buyback.findFirst({ where: { appId: app.id, status: "BURNED" }, orderBy: { completedAt: "desc" }, include: BUYBACK_INCLUDE }),
    db.buildEvent.findFirst({ where: { appId: app.id }, orderBy: { createdAt: "desc" } }),
    db.promptQueueItem.groupBy({ by: ["status"], where: { appId: app.id }, _count: { _all: true } }),
    db.promptQueueItem.findMany({
      where: { appId: app.id, status: { in: ["OPEN", "SCHEDULED"] } },
      orderBy: [{ weight: "desc" }, { createdAt: "asc" }],
      take: 5,
      include: { author: { select: USER_REF_SELECT }, _count: { select: { votes: true } } },
    }),
    db.bounty.aggregate({ where: { appId: app.id, status: "OPEN" }, _sum: { wei: true }, _count: { _all: true } }),
  ]);
  const { items } = await summarize([app]);
  const summary = items[0]!;
  const milestones = z.array(z.string()).safeParse(app.milestones);
  const counts: Record<string, number> = {};
  for (const r of roadmapCounts) counts[r.status] = r._count._all;
  const body: AppDetailDto = {
    ...summary,
    spec: AppSpec.safeParse(app.spec).success ? (app.spec as AppDetailDto["spec"]) : null,
    prompt: app.prompt,
    killedReason: app.killedReason,
    walletAddress: app.walletAddress as Address | null,
    stakeWei: big(app.stakeWei).toString(),
    stakeTx: app.stakeTx as AppDetailDto["stakeTx"],
    stakeRefundTx: app.stakeRefundTx as AppDetailDto["stakeRefundTx"],
    launchTx: app.launchTx as AppDetailDto["launchTx"],
    spentMicros: app.spentMicros.toString(),
    pendingRevenueMicros: app.pendingRevenueMicros.toString(),
    usersCount: app.usersCount,
    uptimeBps: app.uptimeBps,
    healthy: app.healthy,
    unsweptWei: big(app.unsweptWei).toString(),
    escrowWei: big(app.escrowWei).toString(),
    feeSplit: { buildBudget: FEE_SPLIT_BPS.BUILD_BUDGET, pyreToken: FEE_SPLIT_BPS.PYRE_TOKEN, launcher: FEE_SPLIT_BPS.LAUNCHER },
    revenueSplit: { buybackBurn: REVENUE_SPLIT_BPS.BUYBACK_BURN, pyreToken: REVENUE_SPLIT_BPS.PYRE_TOKEN, platformOps: REVENUE_SPLIT_BPS.PLATFORM_OPS },
    graduationThresholdWei: PONS_GRADUATION_THRESHOLD_WEI.toString(),
    budgetHistory: fees.map(feeEventDto),
    lastBuild: lastBuild ? jobDto(lastBuild) : null,
    lastBuyback: lastBuyback ? buybackDto(lastBuyback) : null,
    lastEvent: lastEvent ? eventDto(lastEvent) : null,
    roadmap: { open: counts.OPEN ?? 0, scheduled: counts.SCHEDULED ?? 0, done: counts.DONE ?? 0, top: top.map((t) => queueItemDto(t, false)) },
    bounties: { open: bountyOpen._count._all, openWei: big(bountyOpen._sum.wei).toString() },
    socials: { twitter: app.twitterUrl, website: app.websiteUrl, xAccount: app.xAccount, repoUrl: app.repoUrl },
    forkOf: app.forkOf,
    forks: app._count.forks,
    maintainer: app.maintainer ? userRef(app.maintainer) : null,
    milestones: milestones.success ? milestones.data : [],
    viewer: null,
  };
  return { appId: app.id, launcherId: app.launcherId, maintainerId: app.maintainer?.id ?? null, body };
};

apps.get(
  "/:slug",
  optionalAuth,
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const detail = await cached(cacheKey("apps.detail", { slug }), 5_000, () => loadAppDetail(slug), (v) => [appTag(v.appId)]);
    const user = req.user;
    if (!user) {
      sendCached(res, detail.body, { maxAge: 5, swr: 30 });
      return;
    }
    const wallets = [user.wallet, user.authWallet].filter((w): w is string => typeof w === "string");
    const itemIds = detail.body.roadmap.top.map((q) => q.id);
    const [balances, votes, contributor] = await Promise.all([
      wallets.length ? db.holderBalance.findMany({ where: { appId: detail.appId, wallet: { in: wallets } }, select: { amount: true } }) : Promise.resolve([]),
      itemIds.length > 0 ? db.vote.findMany({ where: { userId: user.id, itemId: { in: itemIds } }, select: { itemId: true } }) : Promise.resolve([]),
      db.contributor.findUnique({ where: { appId_userId: { appId: detail.appId, userId: user.id } }, select: { id: true } }),
    ]);
    const voted: Record<string, true> = {};
    for (const v of votes) voted[v.itemId] = true;
    const units = balances.reduce((acc, b) => acc + big(b.amount), 0n);
    const body: AppDetailDto = {
      ...detail.body,
      roadmap: { ...detail.body.roadmap, top: detail.body.roadmap.top.map((q) => ({ ...q, votedByMe: voted[q.id] === true })) },
      viewer: {
        units: units.toString(),
        pctOfSupply: Number((units * 1_000_000n) / SUPPLY_BASE_UNITS) / 10_000,
        isLauncher: detail.launcherId === user.id,
        isContributor: contributor !== null,
        isMaintainer: detail.maintainerId === user.id,
      },
    };
    sendCached(res, body, { maxAge: 0, private: true });
  }),
);

const FeedQuery = pageQuery(50, 200);

apps.get(
  "/:slug/feed",
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(FeedQuery, req.query);
    const page = await cached(
      cacheKey("apps.feed", { slug, cursor: q.cursor ?? null, limit: q.limit }),
      15_000,
      async () => {
        const app = await appBySlug(slug);
        const rows = await db.buildEvent.findMany({
          where: { appId: app.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: q.limit + 1,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        });
        const items = rows.slice(0, q.limit);
        return { appId: app.id, body: { events: items.map(eventDto), nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null } };
      },
      (v) => [appTag(v.appId)],
    );
    sendCached(res, page.body, { maxAge: 15, swr: 60 });
  }),
);

apps.get(
  "/:slug/feed/stream",
  wrap(async (req, res) => {
    const app = await appBySlug(req.params.slug!);
    sseConnections.add({ stream: "app" }, 1);
    res.on("close", () => sseConnections.add({ stream: "app" }, -1));
    await feedStream(req, res, app.id);
  }),
);

const BuybacksQuery = pageQuery(50, 100);

apps.get(
  "/:slug/buybacks",
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(BuybacksQuery, req.query);
    const page = await cached(
      cacheKey("apps.buybacks", { slug, cursor: q.cursor ?? null, limit: q.limit }),
      15_000,
      async () => {
        const app = await appBySlug(slug);
        const rows = await db.buyback.findMany({
          where: { appId: app.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: q.limit + 1,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
          include: BUYBACK_INCLUDE,
        });
        const items = rows.slice(0, q.limit);
        return { appId: app.id, body: { items: items.map(buybackDto), nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null } };
      },
      (v) => [appTag(v.appId)],
    );
    sendCached(res, page.body, { maxAge: 15, swr: 60 });
  }),
);

const CandleQuery = z.object({ interval: CandleIntervalDto.default("5m"), limit: z.coerce.number().int().min(10).max(2000).default(500) });

/** OHLCV from the runner's candle index plus burn markers; `supply` lets the client toggle price ↔ market cap. */
apps.get(
  "/:slug/candles",
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(CandleQuery, req.query);
    const page = await cached(
      cacheKey("apps.candles", { slug, interval: q.interval, limit: q.limit }),
      20_000,
      async () => {
        const app = await appBySlug(slug);
        const [candles, burns] = await Promise.all([
          db.candle.findMany({ where: { appId: app.id, interval: q.interval }, orderBy: { t: "desc" }, take: q.limit }),
          db.buyback.findMany({
            where: { appId: app.id, status: "BURNED", completedAt: { not: null } },
            orderBy: { completedAt: "desc" },
            take: 200,
            select: { completedAt: true, burnedUnits: true, tokensBurned: true, burnTx: true },
          }),
        ]);
        const body: CandlesDto = {
          interval: q.interval,
          candles: candles.reverse().map(candleDto),
          supply: tokens(SUPPLY_BASE_UNITS - big(app.burnedTokens)),
          burns: burns.map((b) => ({
            t: Math.floor(b.completedAt!.getTime() / 1000),
            units: big(b.burnedUnits ?? b.tokensBurned).toString(),
            txHash: b.burnTx as CandlesDto["burns"][number]["txHash"],
          })),
        };
        return { appId: app.id, body };
      },
      (v) => [appTag(v.appId)],
    );
    sendCached(res, page.body, { maxAge: 20, swr: 60 });
  }),
);

const TradesQuery = pageQuery(50, 200);

apps.get(
  "/:slug/trades",
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(TradesQuery, req.query);
    const page = await cached(
      cacheKey("apps.trades", { slug, cursor: q.cursor ?? null, limit: q.limit }),
      5_000,
      async () => {
        const app = await appBySlug(slug);
        const rows = await db.trade.findMany({
          where: { appId: app.id },
          orderBy: [{ ts: "desc" }, { id: "desc" }],
          take: q.limit + 1,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        });
        const items = rows.slice(0, q.limit);
        return { appId: app.id, body: { items: items.map(tradeDto), nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null } };
      },
      (v) => [appTag(v.appId)],
    );
    sendCached(res, page.body, { maxAge: 5, swr: 30 });
  }),
);

const HoldersQuery = sizeQuery(25, 100);

apps.get(
  "/:slug/holders",
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(HoldersQuery, req.query);
    const top = await cached(
      cacheKey("apps.holders", { slug, limit: q.limit }),
      15_000,
      async () => {
        const app = await appBySlug(slug);
        const holders = await db.holderBalance.findMany({
          where: { appId: app.id, amount: { gt: 0 } },
          orderBy: { amount: "desc" },
          take: q.limit,
          select: { wallet: true, amount: true },
        });
        const ctx = { curveAddress: app.curveAddress, launcherWallet: app.launcher.wallet };
        return {
          appId: app.id,
          body: {
            holders: holders.map((h) => holderDto(h, ctx)),
            supplyUnits: SUPPLY_BASE_UNITS.toString(),
            burnedUnits: big(app.burnedTokens).toString(),
          },
        };
      },
      (v) => [appTag(v.appId)],
    );
    sendCached(res, top.body, { maxAge: 15, swr: 60 });
  }),
);

/** Direct ETH top-up to the app's wallet from the caller's custodial wallet: 100% to build budget, revives dormant apps. */
export const topupHandler = async (req: Request, res: Response): Promise<void> => {
  const app = await prisma.app.findUnique({ where: { slug: req.params.slug! } });
  if (!app) throw new HttpError(404, "app_not_found");
  if (!app.walletAddress) throw new HttpError(409, "app_has_no_wallet");
  if (app.status !== "LIVE" && app.status !== "DORMANT") throw new HttpError(409, "app_not_live");
  const user = req.user!;
  if (!user.wallet) throw new HttpError(400, "wallet_required");
  const body = parse(TopupBody, req.body);
  const wei = ethToWei(body.eth);
  if (wei <= 0n) throw new HttpError(400, "invalid_amount");
  const balance = await custodialEthBalance(user.wallet as Address);
  const need = wei + GAS_RESERVE_WEI;
  if (balance < need) throw new HttpError(400, "insufficient_balance", { needWei: need.toString(), haveWei: balance.toString() });
  let txHash: string;
  try {
    txHash = await transferEth(custodialAccount(user), app.walletAddress as Address, wei);
  } catch (err) {
    logger.error({ err, appId: app.id, userId: user.id }, "top-up transfer failed");
    throw new HttpError(502, "topup_failed");
  }
  const ethPriceUsd = await getEthPriceUsd();
  const usdMicros = usdMicrosFromWei(wei, ethPriceUsd);
  const reviving = app.status === "DORMANT";
  const updated = await prisma.$transaction(async (tx) => {
    const fee = await tx.feeEvent.create({
      data: {
        appId: app.id,
        source: "REVIVE_BUY",
        wei: dec(wei),
        ethPriceUsd,
        usdMicros,
        buildMicros: usdMicros,
        pyreMicros: 0n,
        launcherMicros: 0n,
        txHash,
      },
    });
    await tx.ledgerEntry.create({
      data: { account: `BUILD:${app.id}`, deltaMicros: usdMicros, refType: "FeeEvent", refId: fee.id, memo: "revive top-up" },
    });
    return tx.app.update({
      where: { id: app.id },
      data: {
        budgetMicros: { increment: usdMicros },
        feesWei: { increment: dec(wei) },
        ...(reviving ? { status: "LIVE" } : {}),
      },
    });
  });
  await publishEvent(app.id, {
    type: "BUDGET",
    budgetUsd: usd(updated.budgetMicros),
    delta: usd(usdMicros),
    reason: `top-up from ${user.wallet}`,
  });
  if (reviving) await publishEvent(app.id, { type: "REVIVED", by: user.wallet, budgetUsd: usd(updated.budgetMicros) });
  await publishGlobal(app.id);
  res.json({ budgetMicros: updated.budgetMicros.toString(), status: updated.status, txHash, wei: wei.toString() });
};

apps.post("/:slug/topup", requireAuth, wrap(topupHandler));
