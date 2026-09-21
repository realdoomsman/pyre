import type { Request, Response } from "express";
import { prisma } from "@pyre/db";
import { eventDto } from "../lib/dto.js";
import { subscribeChannel } from "../lib/redis.js";

const HEARTBEAT_MS = 25_000;
const REPLAY_LIMIT = 200;

/** Pulls `id`/`type` out of a published feed message without trusting its shape. */
const frameMeta = (message: string): { id: string; type: string } | null => {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      id: "id" in parsed && typeof parsed.id === "string" ? parsed.id : "",
      type: "type" in parsed && typeof parsed.type === "string" ? parsed.type : "message",
    };
  } catch {
    return null;
  }
};

/**
 * SSE stream of `feed:<appId>`. Subscribes first, then replays events newer than
 * `Last-Event-ID` (header or `?lastEventId=`) so reconnecting clients miss nothing.
 */
export const feedStream = async (req: Request, res: Response, appId: string): Promise<void> => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");

  // Messages arriving while we replay from the DB are buffered, then deduped against the replay.
  let backlog: string[] | null = [];
  const replayed: Record<string, true> = {};
  const unsubscribe = subscribeChannel(`feed:${appId}`, (message) => {
    if (backlog) {
      backlog.push(message);
      return;
    }
    const meta = frameMeta(message);
    if (meta) res.write(`id: ${meta.id}\nevent: ${meta.type}\ndata: ${message}\n\n`);
  });

  const lastIdHeader = req.headers["last-event-id"];
  const lastId =
    (typeof lastIdHeader === "string" ? lastIdHeader : undefined) ??
    (typeof req.query.lastEventId === "string" ? req.query.lastEventId : undefined);
  if (lastId) {
    const anchor = await prisma.buildEvent.findUnique({ where: { id: lastId } });
    if (anchor && anchor.appId === appId) {
      const missed = await prisma.buildEvent.findMany({
        where: { appId, createdAt: { gt: anchor.createdAt } },
        orderBy: { createdAt: "asc" },
        take: REPLAY_LIMIT,
      });
      for (const e of missed) {
        replayed[e.id] = true;
        res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(eventDto(e))}\n\n`);
      }
    }
  }
  const buffered = backlog;
  backlog = null;
  for (const message of buffered) {
    const meta = frameMeta(message);
    if (meta && !replayed[meta.id]) res.write(`id: ${meta.id}\nevent: ${meta.type}\ndata: ${message}\n\n`);
  }

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
};
