import { Router } from "express";
import { z } from "zod";
import { prisma } from "@pyre/db";
import { requireAuth } from "../lib/auth.js";
import { parse, wrap } from "../lib/errors.js";
import { notificationDto } from "../lib/dto.js";

/**
 * In-app notifications for the signed-in user: a capped feed of the newest 50 plus an unread
 * count, and a mark-read endpoint (one by id, or all when omitted). Rows are written elsewhere
 * (proposal status changes in the API, build/fees hooks in the runner) via `prisma.notification`.
 */
export const notifications = Router();

const ReadBody = z.object({ id: z.string().optional(), ids: z.array(z.string()).max(200).optional() });

/** `GET /v1/me/notifications` — newest 50 for the caller, plus the unread count. */
notifications.get(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    const userId = req.user!.id;
    const [rows, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }], take: 50 }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    res.json({ items: rows.map(notificationDto), unread });
  }),
);

/** `POST /v1/me/notifications/read` — mark one (`id`), several (`ids`) or all of the caller's notifications read. */
notifications.post(
  "/read",
  requireAuth,
  wrap(async (req, res) => {
    const userId = req.user!.id;
    const { id, ids } = parse(ReadBody, req.body);
    const target = ids ?? (id ? [id] : null);
    const where = target ? { id: { in: target }, userId, readAt: null } : { userId, readAt: null };
    await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
    const unread = await prisma.notification.count({ where: { userId, readAt: null } });
    res.json({ ok: true, unread });
  }),
);
