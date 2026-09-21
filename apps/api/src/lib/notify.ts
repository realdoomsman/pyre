import { prisma } from "@pyre/db";
import { logger } from "./logger.js";

/**
 * Best-effort in-app notification: writes a `Notification` row for a user. Never throws into
 * callers — a failed insert is logged and swallowed so business paths (proposal status changes,
 * build/fees hooks) are never rolled back by a notification write.
 */
export const notify = async (
  userId: string,
  n: { type: string; title: string; body?: string; href?: string },
): Promise<void> => {
  try {
    await prisma.notification.create({ data: { userId, ...n } });
  } catch (err: unknown) {
    logger.error({ err, userId, type: n.type }, "notification write failed");
  }
};
