import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../env.js";
import { readJson } from "../body.js";
import type { HostContext } from "../resolve.js";
import { currentUser, readCookie } from "../session.js";
import { touchUserSession, touchVisitor } from "../users.js";

const VISITOR_COOKIE = "pyre_app_visitor";
const VISITOR_TTL_S = 180 * 24 * 3600;

const signVisitor = (id: string): string =>
  createHmac("sha256", env.SESSION_SECRET).update(`visitor.${id}`).digest("base64url");

/**
 * Signed opaque visitor id — random bytes only, never anything derived from the request. Also used
 * as a rate-limit identity so users behind one NAT do not share a bucket; a caller that drops the
 * cookie simply falls back to the (equally limited) IP bucket, so this cannot be used to escape one.
 */
export function readVisitor(req: Request): string | null {
  const raw = readCookie(req, VISITOR_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) return null;
  const expected = Buffer.from(signVisitor(id));
  const given = Buffer.from(raw.slice(dot + 1));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return id;
}

/**
 * `POST /_pyre/track` — heartbeat from the app shell. Signed-in users get an AppUserSession row;
 * anonymous visitors are counted once per signed cookie so `usersCount` is not login-gated.
 */
export async function trackRoute(ctx: HostContext, req: Request, res: Response): Promise<void> {
  // Drain (and validate) the body: the SDK may send a beacon payload, but nothing in it is stored.
  await readJson(req, 4096);
  const user = await currentUser(req, ctx.app.id);
  if (user) {
    await touchUserSession(ctx.app.id, user.id);
    res.json({ ok: true, identified: true });
    return;
  }
  let id = readVisitor(req);
  if (!id) {
    id = randomBytes(12).toString("base64url");
    const attrs = [`Path=${ctx.basePath || "/"}`, "HttpOnly", "SameSite=Lax", `Max-Age=${VISITOR_TTL_S}`];
    if (env.NODE_ENV === "production") attrs.push("Secure");
    res.append("Set-Cookie", `${VISITOR_COOKIE}=${id}.${signVisitor(id)}; ${attrs.join("; ")}`);
  }
  await touchVisitor(ctx.app.id, id);
  res.json({ ok: true, identified: false });
}
