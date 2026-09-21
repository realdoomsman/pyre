import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { prisma, type User } from "@pyre/db";
import { env } from "../env.js";

export const SESSION_COOKIE = "pyre_app_session";
const SESSION_TTL_S = 30 * 24 * 3600;

const sign = (payload: string): string => createHmac("sha256", env.SESSION_SECRET).update(payload).digest("base64url");

export function createSessionCookie(userId: string, appId: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = `${userId}.${appId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the userId when the cookie is well-formed, unexpired, bound to this app and correctly signed. */
export function verifySessionCookie(value: string, appId: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [userId, cookieApp, expStr, mac] = parts as [string, string, string, string];
  if (cookieApp !== appId || !userId) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const expected = Buffer.from(sign(`${userId}.${cookieApp}.${expStr}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return userId;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function setSessionCookie(res: Response, value: string | null, basePath: string): void {
  // Strict is safe here: the SDK's Google sign-in exchanges the credential with a same-origin `fetch`
  // from the app page, and Strict cookies are still sent on same-origin subresource requests after a
  // cross-site navigation — only the navigation itself omits them, and no app HTML depends on the session.
  const attrs = [`Path=${basePath || "/"}`, "HttpOnly", "SameSite=Strict"];
  if (env.NODE_ENV === "production") attrs.push("Secure");
  attrs.push(value ? `Max-Age=${SESSION_TTL_S}` : "Max-Age=0");
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${value ? encodeURIComponent(value) : ""}; ${attrs.join("; ")}`);
}

const USER_TTL_MS = 30_000;
const userCache = new Map<string, { user: User | null; expires: number }>();

export async function currentUser(req: Request, appId: string): Promise<User | null> {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const userId = verifySessionCookie(raw, appId);
  if (!userId) return null;
  const hit = userCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.user;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const usable = user && !user.bannedAt ? user : null;
  userCache.set(userId, { user: usable, expires: Date.now() + USER_TTL_MS });
  if (userCache.size > 10_000) {
    const now = Date.now();
    for (const [k, v] of userCache) if (v.expires <= now) userCache.delete(k);
  }
  return usable;
}

export function forgetUser(userId: string): void {
  userCache.delete(userId);
}
