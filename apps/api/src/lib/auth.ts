import type { RequestHandler } from "express";
import { prisma, type User } from "@pyre/db";
import { REPUTATION_TIERS } from "@pyre/shared";
import { HttpError } from "./errors.js";
import { logger } from "./logger.js";
import { verifySession } from "./session.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

const resolveUser = async (authorization: string | undefined): Promise<User | null> => {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (token.length === 0) return null;
  const session = await verifySession(token);
  if (!session) throw new HttpError(401, "invalid_token");
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) throw new HttpError(401, "invalid_token");
  if (user.tokenVersion !== session.tokenVersion) throw new HttpError(401, "session_revoked");
  if (user.bannedAt !== null) throw new HttpError(403, "banned");
  return user;
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  resolveUser(req.headers.authorization)
    .then((user) => {
      if (!user) throw new HttpError(401, "unauthorized");
      req.user = user;
      next();
    })
    .catch(next);
};

/** Attaches `req.user` when a valid bearer is present; a missing, stale, or revoked token falls through
 * to anonymous so public pages still render (only genuine errors — banned, DB failure — propagate). */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  resolveUser(req.headers.authorization)
    .then((user) => {
      if (user) req.user = user;
      next();
    })
    .catch((err: unknown) => {
      if (err instanceof HttpError && err.status === 401) return next();
      next(err);
    });
};

export const requireAdmin: RequestHandler = (req, res, next) => {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.user?.isAdmin) return next(new HttpError(403, "forbidden"));
    next();
  });
};

export const reputationTier = (reputation: number): "NEW" | "TRUSTED" | "VETERAN" =>
  reputation >= REPUTATION_TIERS.VETERAN ? "VETERAN" : reputation >= REPUTATION_TIERS.TRUSTED ? "TRUSTED" : "NEW";
