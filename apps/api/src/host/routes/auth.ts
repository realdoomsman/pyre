import type { Request, Response } from "express";
import { z } from "zod";
import { HttpError, parse } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { verifyGoogleIdToken } from "../../lib/google.js";
import { upsertGoogleUser } from "../../lib/identity.js";
import { readJson } from "../body.js";
import type { HostContext } from "../resolve.js";
import { createSessionCookie, currentUser, forgetUser, setSessionCookie } from "../session.js";
import { touchUserSession } from "../users.js";

const ExchangeBody = z.object({ credential: z.string().min(16).max(8192) });

/**
 * `POST /_pyre/auth/exchange` — trades a Google ID token (from the SDK's in-app Google sign-in) for
 * the per-app session cookie. Apps live on their own origin, so they authenticate independently of
 * pyre.fun; the cookie is scoped to the app's base path so path-routed apps never see each other's
 * sessions. Verifying the Google token here also lazily provisions the user's custodial wallet.
 */
export async function authExchange(ctx: HostContext, req: Request, res: Response): Promise<void> {
  const body = parse(ExchangeBody, await readJson(req, 16 * 1024));
  let identity;
  try {
    identity = await verifyGoogleIdToken(body.credential);
  } catch (err) {
    logger.debug({ err, slug: ctx.app.slug }, "host: google credential rejected");
    throw new HttpError(401, "invalid credential");
  }
  const user = await upsertGoogleUser(identity);
  if (user.bannedAt !== null) throw new HttpError(403, "account suspended");
  await touchUserSession(ctx.app.id, user.id);
  forgetUser(user.id);
  setSessionCookie(res, createSessionCookie(user.id, ctx.app.id), ctx.basePath);
  res.json({ user: { id: user.id, wallet: user.wallet, displayName: user.displayName } });
}

/** `POST /_pyre/auth/logout` — clears the app session cookie. */
export async function authLogout(ctx: HostContext, req: Request, res: Response): Promise<void> {
  const user = await currentUser(req, ctx.app.id);
  if (user) forgetUser(user.id);
  setSessionCookie(res, null, ctx.basePath);
  res.json({ ok: true });
}
