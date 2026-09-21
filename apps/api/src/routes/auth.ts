import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { prisma, type User } from "@pyre/db";
import { WalletChallengeBody, WalletVerifyBody } from "@pyre/shared";
import { requireAuth } from "../lib/auth.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { verifyGoogleIdToken } from "../lib/google.js";
import { upsertGoogleUser, upsertWalletUser } from "../lib/identity.js";
import { signSession } from "../lib/session.js";
import { CHALLENGE_TTL_SECONDS, verifyWalletLogin, walletChallenge } from "../lib/wallet.js";

export const auth = Router();

/** The public account shape handed back on login; mirrored by the web `AuthenticatedUser` type. */
const sessionUser = (user: User) => ({
  id: user.id,
  wallet: user.wallet,
  authWallet: user.authWallet,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
  xHandle: user.xHandle,
  isAdmin: user.isAdmin,
});

const issue = async (user: User, res: Response): Promise<void> => {
  if (user.bannedAt !== null) throw new HttpError(403, "banned");
  res.json({ token: await signSession(user.id, user.tokenVersion), user: sessionUser(user) });
};

/** `POST /v1/auth/google` — verifies a GIS ID token, upserts the user, returns a session. */
auth.post(
  "/google",
  wrap(async (req, res) => {
    const { credential } = parse(z.object({ credential: z.string().min(16).max(8192) }), req.body);
    let identity;
    try {
      identity = await verifyGoogleIdToken(credential);
    } catch {
      throw new HttpError(401, "invalid_google_token");
    }
    await issue(await upsertGoogleUser(identity), res);
  }),
);

/** `POST /v1/auth/wallet/challenge` — `{address}` → the EIP-191 message the wallet must `personal_sign`. */
auth.post(
  "/wallet/challenge",
  wrap(async (req, res) => {
    const { address } = parse(WalletChallengeBody, req.body);
    const challenge = await walletChallenge(address);
    res.json({ ...challenge, address, ttlSeconds: CHALLENGE_TTL_SECONDS });
  }),
);

/** `POST /v1/auth/wallet/verify` — `{address, signature}`; consumes the challenge, upserts the user, returns a session. */
auth.post(
  "/wallet/verify",
  wrap(async (req, res) => {
    const { address, signature } = parse(WalletVerifyBody, req.body);
    if (!(await verifyWalletLogin(address, signature as `0x${string}`))) throw new HttpError(401, "invalid_signature");
    await issue(await upsertWalletUser(address), res);
  }),
);

/**
 * `POST /v1/auth/logout` — revokes the caller's sessions by bumping their token version, so the
 * bearer just used (and every other outstanding token) stops validating. The client also drops
 * its stored token; this makes the server side authoritative rather than trusting the client.
 */
auth.post(
  "/logout",
  requireAuth,
  wrap(async (req, res) => {
    await prisma.user.update({ where: { id: req.user!.id }, data: { tokenVersion: { increment: 1 } } });
    res.json({ ok: true });
  }),
);
