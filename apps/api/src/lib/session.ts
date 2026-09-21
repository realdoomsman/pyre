import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";

/**
 * Self-hosted platform session tokens. Replaces the Privy access token: after a Google or
 * wallet login the client holds one of these and sends it as `Authorization: Bearer <token>`.
 * HS256 signed with SESSION_SECRET — the same secret the per-app host cookie uses.
 */
const secret = new TextEncoder().encode(env.SESSION_SECRET);
const TTL = "30d";

export const signSession = (userId: string, tokenVersion: number): Promise<string> =>
  new SignJWT({ tv: tokenVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(secret);

/** A verified session: the user it belongs to and the token-version it was minted at. */
export interface Session {
  userId: string;
  tokenVersion: number;
}

/**
 * Returns the subject + token-version for a valid, unexpired session token, else null. The caller
 * MUST still check `tokenVersion` against the user's current value — a logout/compromise bumps it,
 * invalidating every token minted before the bump. Tokens issued before this claim existed read as 0.
 */
export const verifySession = async (token: string): Promise<Session | null> => {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    return { userId: payload.sub, tokenVersion: typeof payload.tv === "number" ? payload.tv : 0 };
  } catch {
    return null;
  }
};
