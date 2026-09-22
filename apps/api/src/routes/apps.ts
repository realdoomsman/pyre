import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { big, dec, prisma, type Prisma } from "@pyre/db";
import {
  AppSort,
  AppSpec,
  CandleIntervalDto,
  FEE_SPLIT_BPS_BY_CHAIN,
  PONS_GRADUATION_THRESHOLD_WEI,
  TopupBody,
  VENUES,
  decimalToUnits,
  usdMicrosFromNative,
  type AppDetailDto,
  type AppSummaryDto,
  type AppsPageDto,
  type CandlesDto,
  type CoinBurnsPageDto,
} from "@pyre/shared";
import { optionalAuth, requireAuth } from "../lib/auth.js";
import { APPS_TAG, appTag, cacheKey, cached } from "../lib/cache.js";
import { GAS_RESERVE_BY_CHAIN } from "../lib/custodial.js";
import {
  APP_SUMMARY_SELECT,
  USER_REF_SELECT,
  appExtrasByApp,
  appSummary,
  candleDto,
  coinBurnDto,
  eventDto,
  feeEventDto,
  holderDto,
  jobDto,
  nativeUsd,
  queueItemDto,
  tokens,
  tradeDto,
  usd,
  userRef,
  type AppExtras,
  type AppSummaryRow,
  type NativePrices,
} from "../lib/dto.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { GLOBAL_FEED_CHANNEL, publishEvent, publishGlobal } from "../lib/events.js";
import { pageQuery, sendCached, sizeQuery } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { marketSnapshot } from "../lib/market.js";
import { db, sseConnections } from "../lib/metrics.js";
import { subscribeChannel } from "../lib/redis.js";
import { adapterOf, metaOf, venuesDto } from "../lib/venue.js";
import { env } from "../env.js";
import { feedStream } from "./feed-stream.js";

export const apps = Router();

const DAY_MS = 86_400_000;

/** Statuses visible on the public feed — and only once a token is actually linked. */
const PUBLIC: Prisma.AppWhereInput = { status: { in: ["LIVE", "DORMANT"] }, tokenAddress: { not: null } };

const since24h = () => new Date(Date.now() - DAY_MS);

/**
 * Feed filters. `where` narrows the set; `orderBy` ranks it in the database when the ranking
 * inputs are columns. Trending ranks on 24h aggregates instead, so it loads the candidate set
 * and sorts in memory (`rank`), paging by offset.
 */
interface RankInputs {
  extras: AppExtras;
  prices: NativePrices;
}

const FILTERS: Record<AppSort, { where: () => Prisma.AppWhereInput; orderBy?: Prisma.AppOrderByWithRelationInput[]; rank?: (a: AppSummaryDto, r: RankInputs) => number }> = {
  trending: {
    where: () => PUBLIC,
    rank: (a, r) => a.volume24hUsd + 2 * nativeUsd(r.extras.fees24hWei, a.chain, r.prices) + 100 * a.heat,
  },
  new: { where: () => PUBLIC, orderBy: [{ launchedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }] },
  heating: { where: () => ({ ...PUBLIC, launchPhase: 0 }), orderBy: [{ progress: "desc" }, { volume24hUsd: "desc" }, { id: "desc" }] },
  graduated: { where: () => ({ ...PUBLIC, launchPhase: 2 }), orderBy: [{ graduatedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }] },
  shipping: { where: () => ({ ...PUBLIC, liveVersion: { gt: 0 } }), orderBy: [{ liveVersion: "desc" }, { updatedAt: "desc" }, { id: "desc" }] },
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

export const ListQuery = pageQuery(24, 100).extend({ sort: AppSort.default("trending"), q: z.string().trim().min(1).max(64).optional() });

/** Rows → summaries. Native prices come from the runner's snapshot row (cached, DB-only): this sits on every list and detail read. */
const summarize = async (rows: AppSummaryRow[]): Promise<{ items: AppSummaryDto[]; extras: Record<string, AppExtras>; prices: NativePrices }> => {
  const [extras, market] = await Promise.all([appExtrasByApp(rows.map((a) => a.id)), marketSnapshot()]);
  const prices: NativePrices = { ethPriceUsd: market?.ethPriceUsd ?? 0, solPriceUsd: market?.solPriceUsd ?? 0 };
  return { items: rows.map((a) => appSummary(a, extras[a.id]!, prices)), extras, prices };
};

export const listApps = async (q: z.infer<typeof ListQuery>): Promise<AppsPageDto> => {
  const filter = FILTERS[q.sort];
  if (filter.rank) {
    const offset = offsetOf(q.cursor);
    const rows = await db.app.findMany({ where: filter.where(), orderBy: [{ updatedAt: "desc" }], take: RANK_WINDOW, select: APP_SUMMARY_SELECT });
    const { items, extras, prices } = await summarize(rows);
    const rank = filter.rank;
    const scored = items
      .map((a) => ({ a, s: rank(a, { extras: extras[a.id]!, prices }) }))
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

/** Public summary of one live coin, or null; the app host serves this to apps as `/_pyre/coins/:slug`. */
export const coinSummary = async (slug: string): Promise<AppSummaryDto | null> => {
  const row = await db.app.findFirst({ where: { ...PUBLIC, slug }, select: APP_SUMMARY_SELECT });
  if (!row) return null;
  const { items } = await summarize([row]);
  return items[0] ?? null;
};

/** OHLCV page for a live coin, or null; shared by `/v1/apps/:slug/candles` and the app host. */
export const coinCandles = async (slug: string, q: z.infer<typeof CandleQuery>): Promise<{ appId: string; body: CandlesDto } | null> => {
  const app = await db.app.findFirst({ where: { ...PUBLIC, slug }, select: { id: true, launchpad: true } });
  if (!app) return null;
  const venue = VENUES[app.launchpad];
  const candles = await db.candle.findMany({ where: { appId: app.id, interval: q.interval }, orderBy: { t: "desc" }, take: q.limit });
  return { appId: app.id, body: { interval: q.interval, candles: candles.reverse().map(candleDto), supply: tokens(venue.totalSupplyUnits, venue.tokenDecimals) } };
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
        orderBy: [{ marketCapUsd: "desc" }, { volume24hUsd: "desc" }],
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

const APP_IDENTITY_SELECT = { id: true, slug: true, ticker: true, name: true, chain: true, launchpad: true } as const;

/** SSE of `feed:*global*`, each frame labelled with the app (and its venue, so native amounts format right) so the live tape needs no lookup. */
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
        const frame = { appId, slug: app.slug, ticker: app.ticker, name: app.name, chain: app.chain, launchpad: app.launchpad, type: typeof parsed.type === "string" ? parsed.type : "UPDATE", event: parsed.event };
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
    select: { id: true, chain: true, launchpad: true, tokenAddress: true, curveAddress: true, launchPhase: true, launcher: { select: { wallet: true, solWallet: true } } },
  });
  if (!app || !app.tokenAddress) throw new HttpError(404, "app_not_found");
  return app;
};

/**
 * Native raised on the curve at which the coin graduates: a PONS constant on Robinhood Chain; on
 * pump.fun it follows the program's global config, read through the adapter and cached (it only
 * changes with pump's parameters, never per coin).
 */
const graduationThreshold = (app: Pick<AppSummaryRow, "chain" | "launchpad" | "tokenAddress">): Promise<bigint> =>
  app.chain === "robinhood" || !app.tokenAddress
    ? Promise.resolve(PONS_GRADUATION_THRESHOLD_WEI)
    : cached(cacheKey("venue.graduation", { launchpad: app.launchpad }), 600_000, async () => (await adapterOf(app).readLaunch(app.tokenAddress!)).graduationNative.toString()).then(BigInt);

/** `COINBURN:<appId>` balance plus the app's burn history for the coin page; null on Robinhood Chain where that leg burns PYRE. */
const coinBurnsOf = async (app: Pick<AppSummaryRow, "id" | "chain" | "launchpad">): Promise<AppDetailDto["coinBurns"]> => {
  if (app.chain === "robinhood") return null;
  const [burned, pending, last] = await Promise.all([
    db.coinBurn.aggregate({ where: { appId: app.id, status: "BURNED" }, _sum: { nativeWei: true, burnedUnits: true, tokensBurned: true }, _count: { _all: true } }),
    db.ledgerEntry.aggregate({ where: { account: `COINBURN:${app.id}` }, _sum: { deltaMicros: true } }),
    db.coinBurn.findFirst({ where: { appId: app.id, status: "BURNED" }, orderBy: { completedAt: "desc" } }),
  ]);
  const burnedUnits = big(burned._sum.burnedUnits) > 0n ? big(burned._sum.burnedUnits) : big(burned._sum.tokensBurned);
  return {
    count: burned._count._all,
    nativeWei: big(burned._sum.nativeWei).toString(),
    burnedUnits: burnedUnits.toString(),
    burnedPctOfSupply: Number((burnedUnits * 1_000_000n) / metaOf(app).totalSupplyUnits) / 10_000,
    pendingMicros: (pending._sum.deltaMicros ?? 0n).toString(),
    last: last ? coinBurnDto(last, app) : null,
  };
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
  const [fees, lastBuild, lastEvent, roadmapCounts, top, bountyOpen] = await db.$transaction([
    db.feeEvent.findMany({ where: { appId: app.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    db.buildJob.findFirst({ where: { appId: app.id, status: { in: ["SUCCEEDED", "FAILED", "RUNNING"] } }, orderBy: { createdAt: "desc" } }),
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
  const [{ items }, graduationNative, coinBurns] = await Promise.all([summarize([app]), graduationThreshold(app), coinBurnsOf(app)]);
  const summary = items[0]!;
  const milestones = z.array(z.string()).safeParse(app.milestones);
  const counts: Record<string, number> = {};
  for (const r of roadmapCounts) counts[r.status] = r._count._all;
  const split = FEE_SPLIT_BPS_BY_CHAIN[app.chain];
  const body: AppDetailDto = {
    ...summary,
    spec: AppSpec.safeParse(app.spec).success ? (app.spec as AppDetailDto["spec"]) : null,
    prompt: app.prompt,
    killedReason: app.killedReason,
    walletAddress: app.walletAddress,
    stakeWei: big(app.stakeWei).toString(),
    stakeTx: app.stakeTx,
    stakeRefundTx: app.stakeRefundTx,
    launchTx: app.launchTx,
    spentMicros: app.spentMicros.toString(),
    usersCount: app.usersCount,
    uptimeBps: app.uptimeBps,
    healthy: app.healthy,
    unsweptWei: big(app.unsweptWei).toString(),
    escrowWei: big(app.escrowWei).toString(),
    feeSplit: { buildBudget: split.BUILD_BUDGET, pyreToken: split.PYRE_TOKEN, coinBurn: split.COIN_BURN, launcher: split.LAUNCHER },
    graduationThresholdWei: graduationNative.toString(),
    coinBurns,
    budgetHistory: fees.map(feeEventDto),
    lastBuild: lastBuild ? jobDto(lastBuild) : null,
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
    // The viewer's wallets on the coin's chain: custodial + proven external on Robinhood Chain, custodial Solana on Solana.
    const wallets = (detail.body.chain === "solana" ? [user.solWallet] : [user.wallet, user.authWallet]).filter((w): w is string => typeof w === "string");
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
        pctOfSupply: Number((units * 1_000_000n) / VENUES[detail.body.launchpad].totalSupplyUnits) / 10_000,
        isLauncher: detail.launcherId === user.id,
        isContributor: contributor !== null,
        isMaintainer: detail.maintainerId === user.id,
      },
    };
    sendCached(res, body, { maxAge: 0, private: true });
  }),
);

/** `kind=build` leaves out market noise (trades, fee claims, growth posts) so a log tail is a log tail. */
const FeedQuery = pageQuery(50, 200).extend({ kind: z.enum(["all", "build"]).default("all") });
const MARKET_EVENT_TYPES = ["TRADE", "FEES", "GROWTH_POST", "LAUNCH", "GRADUATED"];

apps.get(
  "/:slug/feed",
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(FeedQuery, req.query);
    const page = await cached(
      cacheKey("apps.feed", { slug, cursor: q.cursor ?? null, limit: q.limit, kind: q.kind }),
      15_000,
      async () => {
        const app = await appBySlug(slug);
        const rows = await db.buildEvent.findMany({
          where: q.kind === "build" ? { appId: app.id, type: { notIn: MARKET_EVENT_TYPES } } : { appId: app.id },
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

export const CandleQuery = z.object({ interval: CandleIntervalDto.default("5m"), limit: z.coerce.number().int().min(10).max(2000).default(500) });

/** OHLCV from the runner's candle index; `supply` lets the client toggle price ↔ market cap. */
apps.get(
  "/:slug/candles",
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(CandleQuery, req.query);
    const page = await cached(
      cacheKey("apps.candles", { slug, interval: q.interval, limit: q.limit }),
      20_000,
      async () => {
        const page = await coinCandles(slug, q);
        if (!page) throw new HttpError(404, "app_not_found");
        return page;
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
          select: { wallet: true, amount: true, tag: true },
        });
        const ctx = { chain: app.chain, launchpad: app.launchpad, curveAddress: app.curveAddress, launcherWallet: app.chain === "solana" ? app.launcher.solWallet : app.launcher.wallet };
        return {
          appId: app.id,
          body: {
            holders: holders.map((h) => holderDto(h, ctx)),
            supplyUnits: metaOf(app).totalSupplyUnits.toString(),
          },
        };
      },
      (v) => [appTag(v.appId)],
    );
    sendCached(res, top.body, { maxAge: 15, swr: 60 });
  }),
);

/**
 * Direct native top-up to the app's wallet from the caller's custodial wallet on the app's chain:
 * 100% to build budget, revives dormant apps. `amount` is whole ETH or SOL.
 */
export const topupHandler = async (req: Request, res: Response): Promise<void> => {
  const app = await prisma.app.findUnique({ where: { slug: req.params.slug! } });
  if (!app) throw new HttpError(404, "app_not_found");
  if (!app.walletAddress) throw new HttpError(409, "app_has_no_wallet");
  if (app.status !== "LIVE" && app.status !== "DORMANT") throw new HttpError(409, "app_not_live");
  const user = req.user!;
  if (!user.wallet) throw new HttpError(400, "wallet_required");
  const body = parse(TopupBody, req.body);
  const venue = adapterOf(app);
  const { decimals } = venue.info.native;
  const wei = decimalToUnits(String(body.amount), decimals);
  if (wei <= 0n) throw new HttpError(400, "invalid_amount");
  const account = venue.userWallet(user.walletIndex);
  const balance = await venue.nativeBalance(account.address);
  const need = wei + GAS_RESERVE_BY_CHAIN[app.chain];
  if (balance < need) throw new HttpError(400, "insufficient_balance", { needWei: need.toString(), haveWei: balance.toString() });
  let txHash: string;
  try {
    txHash = (await venue.transferNative(account, app.walletAddress, wei)).hash;
  } catch (err) {
    logger.error({ err, appId: app.id, userId: user.id }, "top-up transfer failed");
    throw new HttpError(502, "topup_failed");
  }
  const ethPriceUsd = await venue.nativePriceUsd();
  const usdMicros = usdMicrosFromNative(wei, ethPriceUsd, decimals);
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
    reason: `top-up from ${account.address}`,
  });
  if (reviving) await publishEvent(app.id, { type: "REVIVED", by: account.address, budgetUsd: usd(updated.budgetMicros) });
  await publishGlobal(app.id);
  res.json({ budgetMicros: updated.budgetMicros.toString(), status: updated.status, txHash, wei: wei.toString() });
};

apps.post("/:slug/topup", requireAuth, wrap(topupHandler));

const BurnsQuery = pageQuery(20, 100);

/** Coin buy-and-burns of a Solana app, newest settled first; empty on Robinhood Chain where the leg burns PYRE. */
apps.get(
  "/:slug/burns",
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(BurnsQuery, req.query);
    const page = await cached(
      cacheKey("apps.burns", { slug, cursor: q.cursor ?? null, limit: q.limit }),
      15_000,
      async () => {
        const app = await appBySlug(slug);
        const rows = await db.coinBurn.findMany({
          where: { appId: app.id, status: "BURNED" },
          orderBy: [{ completedAt: "desc" }, { id: "desc" }],
          take: q.limit + 1,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        });
        const items = rows.slice(0, q.limit);
        const body: CoinBurnsPageDto = { items: items.map((b) => coinBurnDto(b, app)), nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
        return { appId: app.id, body };
      },
      (v) => [appTag(v.appId)],
    );
    sendCached(res, page.body, { maxAge: 15, swr: 60 });
  }),
);

/**
 * Coin metadata JSON the launchpad points its on-chain URI at (pump.fun reads `image` from it).
 * Hosted by Pyre — no pinning service — so it is public, cacheable and available before the
 * launch transaction that references it.
 */
apps.get(
  "/:slug/metadata.json",
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const meta = await cached(
      cacheKey("apps.metadata", { slug }),
      60_000,
      async () => {
        const app = await db.app.findUnique({
          where: { slug },
          select: { id: true, name: true, ticker: true, imageUrl: true, spec: true, prompt: true, websiteUrl: true, twitterUrl: true, status: true },
        });
        if (!app || app.status === "DRAFT" || app.status === "SPEC_READY") throw new HttpError(404, "app_not_found");
        const spec = AppSpec.safeParse(app.spec);
        return {
          appId: app.id,
          body: {
            name: app.name,
            symbol: app.ticker,
            description: spec.success ? spec.data.oneLiner : app.prompt.slice(0, 200),
            image: app.imageUrl,
            showName: true,
            createdOn: "https://pyre.fun",
            website: app.websiteUrl ?? `${env.WEB_ORIGIN}/a/${slug}`,
            ...(app.twitterUrl ? { twitter: app.twitterUrl } : {}),
          },
        };
      },
      (v) => [appTag(v.appId)],
    );
    sendCached(res, meta.body, { maxAge: 300, swr: 3600 });
  }),
);

/** Launch venues and whether each accepts launches in this environment. */
export const venues = Router();
venues.get(
  "/",
  wrap(async (_req, res) => {
    sendCached(res, { venues: venuesDto() }, { maxAge: 30, swr: 300 });
  }),
);
