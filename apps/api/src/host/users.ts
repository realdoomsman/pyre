import { Prisma, prisma } from "@pyre/db";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

/** HyperLogLog of anonymous visitor ids; combined with AppUserSession rows for `App.usersCount`. */
const visitorKey = (appId: string): string => `app:${appId}:visitors`;

/**
 * usersCount = distinct signed-in users (durable rows) + distinct anonymous visitors (HLL).
 * Recomputed only when a new identity appears, so the common request path stays a single write.
 */
async function recount(appId: string): Promise<void> {
  try {
    const [sessions, anonymous] = await Promise.all([
      prisma.appUserSession.count({ where: { appId } }),
      redis.pfcount(visitorKey(appId)),
    ]);
    await prisma.app.update({ where: { id: appId }, data: { usersCount: sessions + anonymous } });
  } catch (err) {
    logger.warn({ err, appId }, "host: usersCount recount failed");
  }
}

/** Marks a signed-in user active on this app. Returns true when this is their first visit. */
export async function touchUserSession(appId: string, userId: string): Promise<boolean> {
  const touched = await prisma.appUserSession.updateMany({ where: { appId, userId }, data: { lastSeen: new Date() } });
  if (touched.count > 0) return false;
  try {
    await prisma.appUserSession.create({ data: { appId, userId } });
  } catch (err) {
    // Concurrent first visit: the other request created the row and will recount.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
  await recount(appId);
  return true;
}

/** Marks an anonymous visitor active. Returns true when the visitor id is new to this app. */
export async function touchVisitor(appId: string, visitorId: string): Promise<boolean> {
  let added = 0;
  try {
    added = await redis.pfadd(visitorKey(appId), visitorId);
  } catch (err) {
    logger.warn({ err, appId }, "host: visitor tracking failed");
    return false;
  }
  if (added !== 1) return false;
  await recount(appId);
  return true;
}
