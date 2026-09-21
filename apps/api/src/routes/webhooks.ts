import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Prisma, prisma } from "@pyre/db";
import { env } from "../env.js";
import { HttpError, wrap } from "../lib/errors.js";
import { queues } from "../lib/queues.js";

export const webhooks = Router();

/** GitHub authenticates with an HMAC over the raw body; never compare it with `!==`. */
function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Thrown by `claimDelivery` when this delivery id was already applied. */
class DuplicateDelivery extends Error {}

/**
 * Records the provider's delivery id. Runs inside the same transaction as the effect, so a replay
 * can never re-apply it and a rolled-back effect never leaves the id claimed.
 */
async function claimDelivery(tx: Prisma.TransactionClient, provider: string, id: string): Promise<void> {
  try {
    await tx.webhookEvent.create({ data: { id: `${provider}:${id}`, provider } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new DuplicateDelivery();
    throw err;
  }
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/* ─────────────────────────── GitHub ─────────────────────────── */

const PullRequestEvent = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }),
  pull_request: z.object({
    number: z.number().int(),
    title: z.string(),
    html_url: z.string(),
    merged: z.boolean().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    user: z.object({ login: z.string() }),
    head: z.object({ sha: z.string() }),
  }),
});

const REVIEW_ACTIONS: Record<string, true> = { opened: true, synchronize: true, reopened: true };

webhooks.post(
  "/github",
  wrap(async (req, res) => {
    if (!env.GITHUB_WEBHOOK_SECRET) throw new HttpError(503, "webhook_not_configured");
    const signature = req.headers["x-hub-signature-256"];
    if (typeof signature !== "string" || !req.rawBody) throw new HttpError(401, "missing_signature");
    const expected = `sha256=${createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(req.rawBody).digest("hex")}`;
    if (!secretMatches(signature, expected)) throw new HttpError(401, "bad_signature");
    if (req.headers["x-github-event"] !== "pull_request") {
      res.json({ ok: true, ignored: true });
      return;
    }
    const event = PullRequestEvent.safeParse(req.body);
    if (!event.success) throw new HttpError(400, "bad_payload");
    const { action, repository, pull_request: pr } = event.data;

    // GitHub sends no timestamp header; the delivery id (or payload hash for a stripped proxy) is
    // the replay guard.
    const delivery = req.headers["x-github-delivery"];
    const deliveryId = typeof delivery === "string" && delivery.length > 0 ? delivery : sha256(req.rawBody);
    const prior = await prisma.webhookEvent.findUnique({ where: { id: `github:${deliveryId}` }, select: { id: true } });
    if (prior) {
      res.json({ ok: true, duplicate: true });
      return;
    }

    const app = await prisma.app.findFirst({ where: { repoFullName: repository.full_name }, select: { id: true } });
    if (!app) {
      res.json({ ok: true, ignored: true });
      return;
    }
    const existing = await prisma.pullRequest.findUnique({ where: { appId_number: { appId: app.id, number: pr.number } } });
    try {
      if (action === "closed") {
        if (existing && existing.status !== "MERGED") {
          const data = pr.merged
            ? { status: "MERGED" as const, mergeSha: pr.merge_commit_sha ?? null }
            : { status: "REJECTED" as const };
          await prisma.$transaction(async (tx) => {
            await claimDelivery(tx, "github", deliveryId);
            await tx.pullRequest.update({ where: { id: existing.id }, data });
          });
        }
        res.json({ ok: true });
        return;
      }
      if (!REVIEW_ACTIONS[action] || existing?.status === "MERGED") {
        res.json({ ok: true, ignored: true });
        return;
      }
      await prisma.$transaction(async (tx) => {
        await claimDelivery(tx, "github", deliveryId);
        await tx.pullRequest.upsert({
          where: { appId_number: { appId: app.id, number: pr.number } },
          create: { appId: app.id, number: pr.number, authorLogin: pr.user.login, title: pr.title, url: pr.html_url },
          update: { title: pr.title, url: pr.html_url, status: "OPEN", reviewSummary: null },
        });
      });
    } catch (err) {
      if (err instanceof DuplicateDelivery) {
        res.json({ ok: true, duplicate: true });
        return;
      }
      throw err;
    }
    await queues.prReview.add(
      "prReview",
      { appId: app.id, prNumber: pr.number },
      { jobId: `prReview-${app.id}-${pr.number}-${pr.head.sha}` },
    );
    res.json({ ok: true, queued: true });
  }),
);
