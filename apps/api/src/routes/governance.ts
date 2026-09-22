import { Router } from "express";
import { z } from "zod";
import { big, dec, prisma } from "@pyre/db";
import { EvmAddress, PromptQueueBody } from "@pyre/shared";
import { optionalAuth, requireAuth } from "../lib/auth.js";
import { appTag, cacheKey, cached } from "../lib/cache.js";
import { USER_REF_SELECT, prDto, queueItemDto, userRef } from "../lib/dto.js";
import { sendCached, sizeQuery } from "../lib/http.js";
import { db } from "../lib/metrics.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { publishEvent } from "../lib/events.js";
import { cappedElectorate, contributorMinHold, holderBalance, holderWallet, isElected, voteCap, voteWeight } from "../lib/votes.js";

export const governance = Router();

const liveAppBySlug = async (slug: string) => {
  const app = await prisma.app.findUnique({ where: { slug } });
  if (!app) throw new HttpError(404, "app_not_found");
  return app;
};

const QUEUE_ITEM_INCLUDE = {
  author: { select: USER_REF_SELECT },
  _count: { select: { votes: true } },
} as const;

/** Queue pages are capped server-side; `limit` may only narrow the window. */
const QueueQuery = sizeQuery(100, 100);

governance.get(
  "/apps/:slug/proposals",
  optionalAuth,
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(QueueQuery, req.query);
    const queue = await cached(
      cacheKey("gov.queue", { slug, limit: q.limit }),
      15_000,
      async () => {
        const app = await db.app.findUnique({ where: { slug }, select: { id: true, chain: true, launchpad: true, status: true } });
        if (!app) throw new HttpError(404, "app_not_found");
        const items = await db.promptQueueItem.findMany({
          where: { appId: app.id },
          orderBy: [{ weight: "desc" }, { createdAt: "asc" }],
          take: q.limit,
          include: QUEUE_ITEM_INCLUDE,
        });
        return {
          appId: app.id,
          app: { id: app.id, chain: app.chain, launchpad: app.launchpad },
          submittable: app.status === "LIVE" || app.status === "DORMANT",
          body: {
            items: items.map((item) => queueItemDto(item, false)),
            minHoldUnits: contributorMinHold(app).toString(),
            canSubmit: false,
            myWeightUnits: "0",
          },
        };
      },
      (v) => [appTag(v.appId)],
    );
    const user = req.user;
    if (!user) {
      sendCached(res, queue.body, { maxAge: 15, swr: 60 });
      return;
    }
    const itemIds = queue.body.items.map((i) => i.id);
    const cap = voteCap(queue.app);
    const [balance, votes] = await Promise.all([
      holderBalance(queue.appId, holderWallet(queue.app, user)),
      itemIds.length > 0
        ? db.vote.findMany({ where: { userId: user.id, itemId: { in: itemIds } }, select: { itemId: true } })
        : Promise.resolve([]),
    ]);
    const voted: Record<string, true> = {};
    for (const v of votes) voted[v.itemId] = true;
    sendCached(
      res,
      {
        ...queue.body,
        items: queue.body.items.map((item) => ({ ...item, votedByMe: voted[item.id] === true })),
        canSubmit: balance >= contributorMinHold(queue.app) && queue.submittable,
        myWeightUnits: (balance > cap ? cap : balance).toString(),
      },
      { maxAge: 0, private: true },
    );
  }),
);

governance.post(
  "/apps/:slug/proposals",
  requireAuth,
  wrap(async (req, res) => {
    const user = req.user!;
    const app = await liveAppBySlug(req.params.slug!);
    const body = parse(PromptQueueBody, req.body);
    if (app.status !== "LIVE" && app.status !== "DORMANT") throw new HttpError(409, "app_not_live");
    const balance = await holderBalance(app.id, holderWallet(app, user));
    const minHold = contributorMinHold(app);
    if (balance < minHold) throw new HttpError(403, "insufficient_holding", { minHoldUnits: minHold.toString() });
    const cap = voteCap(app);
    const weight = balance > cap ? cap : balance;
    const item = await prisma.promptQueueItem.create({
      data: {
        appId: app.id,
        authorId: user.id,
        text: body.text,
        weight: dec(weight),
        votes: { create: { userId: user.id, weight: dec(weight) } },
      },
      include: QUEUE_ITEM_INCLUDE,
    });
    res.status(201).json(queueItemDto(item, true));
  }),
);

governance.post(
  "/queue/:id/vote",
  requireAuth,
  wrap(async (req, res) => {
    const user = req.user!;
    const item = await prisma.promptQueueItem.findUnique({ where: { id: req.params.id! }, include: { app: { select: { id: true, chain: true, launchpad: true } } } });
    if (!item) throw new HttpError(404, "queue_item_not_found");
    if (item.status !== "OPEN") throw new HttpError(409, "queue_item_closed");
    const weight = await voteWeight(item.app, holderWallet(item.app, user));
    if (weight === 0n) throw new HttpError(403, "not_a_holder");
    const updated = await prisma.$transaction(async (tx) => {
      await tx.vote.upsert({
        where: { itemId_userId: { itemId: item.id, userId: user.id } },
        create: { itemId: item.id, userId: user.id, weight: dec(weight) },
        update: { weight: dec(weight) },
      });
      const sum = await tx.vote.aggregate({ where: { itemId: item.id }, _sum: { weight: true } });
      return tx.promptQueueItem.update({
        where: { id: item.id },
        data: { weight: sum._sum.weight ?? dec(0) },
        include: QUEUE_ITEM_INCLUDE,
      });
    });
    res.json(queueItemDto(updated, true));
  }),
);

const MaintainerVoteBody = z.object({ candidateWallet: EvmAddress });

governance.post(
  "/apps/:slug/maintainer-vote",
  requireAuth,
  wrap(async (req, res) => {
    const user = req.user!;
    const app = await liveAppBySlug(req.params.slug!);
    const body = parse(MaintainerVoteBody, req.body);
    const weight = await voteWeight(app, holderWallet(app, user));
    if (weight === 0n) throw new HttpError(403, "not_a_holder");
    await prisma.maintainerVote.upsert({
      where: { appId_userId: { appId: app.id, userId: user.id } },
      create: { appId: app.id, userId: user.id, candidateWallet: body.candidateWallet, weight: dec(weight) },
      update: { candidateWallet: body.candidateWallet, weight: dec(weight) },
    });
    const [support, electorate] = await Promise.all([
      prisma.maintainerVote.aggregate({ where: { appId: app.id, candidateWallet: body.candidateWallet }, _sum: { weight: true } }),
      cappedElectorate(app),
    ]);
    const total = big(support._sum.weight);
    const majority = isElected(total, electorate);
    let elected = false;
    if (majority) {
      const candidate = await prisma.user.findUnique({ where: { wallet: body.candidateWallet } });
      if (candidate && app.maintainerId !== candidate.id) {
        await prisma.app.update({ where: { id: app.id }, data: { maintainerId: candidate.id } });
        await publishEvent(app.id, { type: "AGENT_NOTE", text: `Maintainer elected: ${body.candidateWallet}` });
        elected = true;
      } else if (candidate) {
        elected = true;
      }
    }
    res.json({ candidateWallet: body.candidateWallet, weightUnits: total.toString(), elected });
  }),
);

/** Contributor and candidate lists are bounded; a popular repo cannot return an unbounded page. */
const CONTRIBUTOR_MAX = 200;
const CANDIDATE_MAX = 100;
const PrsQuery = sizeQuery(100, 100);

governance.get(
  "/apps/:slug/prs",
  optionalAuth,
  wrap(async (req, res) => {
    const slug = req.params.slug!;
    const q = parse(PrsQuery, req.query);
    const view = await cached(
      cacheKey("gov.prs", { slug, limit: q.limit }),
      15_000,
      async () => {
        const app = await db.app.findUnique({
          where: { slug },
          select: { id: true, maintainer: { select: USER_REF_SELECT } },
        });
        if (!app) throw new HttpError(404, "app_not_found");
        const [prs, contributors, votes] = await db.$transaction([
          db.pullRequest.findMany({ where: { appId: app.id }, orderBy: { number: "desc" }, take: q.limit }),
          db.contributor.findMany({
            where: { appId: app.id },
            orderBy: { mergedPrs: "desc" },
            take: CONTRIBUTOR_MAX,
            select: { userId: true, mergedPrs: true, earnedMicros: true, user: { select: USER_REF_SELECT } },
          }),
          db.maintainerVote.groupBy({
            by: ["candidateWallet"],
            where: { appId: app.id },
            _sum: { weight: true },
            _count: { _all: true },
            orderBy: { _sum: { weight: "desc" } },
            take: CANDIDATE_MAX,
          }),
        ]);
        return {
          appId: app.id,
          body: {
            items: prs.map(prDto),
            contributors: contributors.map((c) => ({
              user: userRef(c.user),
              mergedPrs: c.mergedPrs,
              earnedMicros: c.earnedMicros.toString(),
            })),
            maintainer: app.maintainer ? userRef(app.maintainer) : null,
            myMaintainerVote: null as string | null,
            maintainerVotes: votes.map((v) => ({
              candidateWallet: v.candidateWallet,
              weightUnits: big(v._sum.weight).toString(),
              voters: v._count._all,
            })),
          },
        };
      },
      (v) => [appTag(v.appId)],
    );
    const user = req.user;
    if (!user) {
      sendCached(res, view.body, { maxAge: 15, swr: 60 });
      return;
    }
    const mine = await db.maintainerVote.findUnique({
      where: { appId_userId: { appId: view.appId, userId: user.id } },
      select: { candidateWallet: true },
    });
    sendCached(res, { ...view.body, myMaintainerVote: mine?.candidateWallet ?? null }, { maxAge: 0, private: true });
  }),
);
