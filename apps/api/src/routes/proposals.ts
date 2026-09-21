import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { big, dec, prisma, type Prisma, type ProposalComment, type ProposalStatus } from "@pyre/db";
import { requireAdmin, requireAuth } from "../lib/auth.js";
import { writeAudit } from "../lib/audit.js";
import { USER_REF_SELECT, type UserRefRow, proposalDto, userRef } from "../lib/dto.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { env } from "../env.js";
import { PLATFORM_PROPOSAL_MIN_HOLD, PLATFORM_PROPOSAL_QUORUM, platformHoldWeight } from "../lib/votes.js";
import { verifySession } from "../lib/session.js";
import { notify } from "../lib/notify.js";

/**
 * Platform governance for $PYRE: holders with ≥3% of supply propose improvements to Pyre itself,
 * every holder can vote (capped, token-weighted), and the whole board is public. This is advisory —
 * there is no build loop and no path from a proposal to production. The owner builds what wins and
 * flips the status by hand (admin only). Nothing here touches funds, keys, auth, or the platform code.
 */
export const proposals = Router();

const ProposalBody = z.object({ title: z.string().min(6).max(120), body: z.string().min(20).max(4000) });
const STATUSES = ["OPEN", "PLANNED", "BUILDING", "SHIPPED", "DECLINED"] as const;
const StatusBody = z.object({ status: z.enum(STATUSES), note: z.string().max(1000).optional() });
const PAGE_MAX = 200;

type ProposalRow = Prisma.ProposalGetPayload<{ include: { author: { select: typeof USER_REF_SELECT } } }>;

const commentDto = (c: ProposalComment & { author: UserRefRow }) => ({
  id: c.id,
  author: userRef(c.author),
  body: c.body,
  createdAt: c.createdAt.toISOString(),
});

/** `GET /v1/proposals` — the public board: every proposal with its capped-weight tally + your vote. */
proposals.get(
  "/",
  wrap(async (req, res) => {
    const rows = await prisma.proposal.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: PAGE_MAX,
      include: { author: { select: USER_REF_SELECT }, _count: { select: { comments: true } } },
    });
    const [weights, mine] = await Promise.all([
      prisma.proposalVote.groupBy({ by: ["proposalId"], _sum: { weight: true }, _count: { _all: true } }),
      readOptionalUserVotes(req.headers.authorization),
    ]);
    const byId: Record<string, (typeof weights)[number]> = {};
    for (const w of weights) byId[w.proposalId] = w;
    res.json({
      pyreLaunched: env.PYRE_TOKEN !== undefined,
      minHoldUnits: PLATFORM_PROPOSAL_MIN_HOLD.toString(),
      quorumUnits: PLATFORM_PROPOSAL_QUORUM.toString(),
      items: rows.map((p) => {
        const agg = byId[p.id];
        return proposalDto(p, { weight: big(agg?._sum.weight), votes: agg?._count._all ?? 0, comments: p._count.comments }, mine[p.id] === true);
      }),
    });
  }),
);

/** Best-effort: mark which proposals the caller has voted on, if a valid session is present. */
const readOptionalUserVotes = async (authorization: string | undefined): Promise<Record<string, true>> => {
  const out: Record<string, true> = {};
  if (!authorization?.startsWith("Bearer ")) return out;
  const session = await verifySession(authorization.slice(7).trim());
  if (!session) return out;
  const votes = await prisma.proposalVote.findMany({ where: { userId: session.userId }, select: { proposalId: true } });
  for (const v of votes) out[v.proposalId] = true;
  return out;
};

/** `POST /v1/proposals` — submit a proposal. Gated: caller must hold ≥3% of $PYRE. */
export const submitProposalHandler = async (req: Request, res: Response): Promise<void> => {
  if (env.PYRE_TOKEN === undefined) throw new HttpError(503, "pyre_not_launched");
  const u = req.user!;
  const weight = await platformHoldWeight(u.wallet as `0x${string}` | null);
  if (weight < PLATFORM_PROPOSAL_MIN_HOLD)
    throw new HttpError(403, "insufficient_hold", { needUnits: PLATFORM_PROPOSAL_MIN_HOLD.toString(), haveUnits: weight.toString() });
  const body = parse(ProposalBody, req.body);
  const created: ProposalRow = await prisma.proposal.create({
    data: { authorId: u.id, title: body.title, body: body.body },
    include: { author: { select: USER_REF_SELECT } },
  });
  res.status(201).json(proposalDto(created, { weight: 0n, votes: 0, comments: 0 }, false));
};
proposals.post("/", requireAuth, wrap(submitProposalHandler));

/** `POST /v1/proposals/:id/vote` — cast/replace a capped $PYRE-weighted vote (any holder). */
export const voteProposalHandler = async (req: Request, res: Response): Promise<void> => {
  if (env.PYRE_TOKEN === undefined) throw new HttpError(503, "pyre_not_launched");
  const u = req.user!;
  const weight = await platformHoldWeight(u.wallet as `0x${string}` | null);
  if (weight <= 0n) throw new HttpError(403, "must_hold_pyre");
  const proposal = await prisma.proposal.findUnique({ where: { id: req.params.id! }, select: { id: true } });
  if (!proposal) throw new HttpError(404, "proposal_not_found");
  await prisma.proposalVote.upsert({
    where: { proposalId_userId: { proposalId: proposal.id, userId: u.id } },
    create: { proposalId: proposal.id, userId: u.id, weight: dec(weight) },
    update: { weight: dec(weight) },
  });
  res.json({ ok: true, weightUnits: weight.toString() });
};
proposals.post("/:id/vote", requireAuth, wrap(voteProposalHandler));

/** `DELETE /v1/proposals/:id/vote` — withdraw your vote. */
proposals.delete(
  "/:id/vote",
  requireAuth,
  wrap(async (req, res) => {
    await prisma.proposalVote.deleteMany({ where: { proposalId: req.params.id!, userId: req.user!.id } });
    res.json({ ok: true });
  }),
);

/** `POST /v1/proposals/:id/status` — owner-only: move a proposal through the roadmap. */
proposals.post(
  "/:id/status",
  requireAdmin,
  wrap(async (req, res) => {
    const body = parse(StatusBody, req.body);
    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.id! } });
    if (!proposal) throw new HttpError(404, "proposal_not_found");
    const data: Prisma.ProposalUpdateInput = { status: body.status as ProposalStatus };
    if (body.note !== undefined) data.ownerNote = body.note;
    const updated = await prisma.proposal.update({ where: { id: proposal.id }, data });
    await writeAudit({
      actorId: req.user!.id,
      actor: `admin:${req.user!.id}`,
      action: "PROPOSAL_STATUS",
      targetType: "Proposal",
      targetId: proposal.id,
      meta: { status: body.status, note: body.note ?? null },
    }).catch((err: unknown) => logger.error({ err, proposalId: proposal.id }, "proposal status audit write failed"));
    await notify(proposal.authorId, {
      type: "PROPOSAL_STATUS",
      title: `Your proposal is now ${updated.status}`,
      href: "/governance",
    });
    res.json({ ok: true, status: updated.status });
  }),
);

const CommentBody = z.object({ body: z.string().min(1).max(2000) });

/** `GET /v1/proposals/:id/comments` — public discussion thread, oldest first. */
proposals.get(
  "/:id/comments",
  wrap(async (req, res) => {
    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.id! }, select: { id: true } });
    if (!proposal) throw new HttpError(404, "proposal_not_found");
    const rows = await prisma.proposalComment.findMany({
      where: { proposalId: proposal.id },
      orderBy: [{ createdAt: "asc" }],
      take: PAGE_MAX,
      include: { author: { select: USER_REF_SELECT } },
    });
    res.json({ items: rows.map(commentDto) });
  }),
);

/** `POST /v1/proposals/:id/comments` — add a comment (any signed-in user). */
proposals.post(
  "/:id/comments",
  requireAuth,
  wrap(async (req, res) => {
    const body = parse(CommentBody, req.body);
    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.id! }, select: { id: true } });
    if (!proposal) throw new HttpError(404, "proposal_not_found");
    const created = await prisma.proposalComment.create({
      data: { proposalId: proposal.id, authorId: req.user!.id, body: body.body },
      include: { author: { select: USER_REF_SELECT } },
    });
    res.status(201).json(commentDto(created));
  }),
);
