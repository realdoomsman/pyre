import type { Request, Response } from "express";
import { Prisma, prisma } from "@pyre/db";
import { HttpError } from "../../lib/errors.js";
import { readJson } from "../body.js";
import type { HostContext } from "../resolve.js";
import { currentUser } from "../session.js";

const KEY_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_VALUE_BYTES = 64 * 1024;
export const APP_SCOPE = "app";

export function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new HttpError(400, "invalid key: use 1-120 chars of A-Z a-z 0-9 _ . : -");
}

/** Rejects values that are not JSON-serializable or exceed the per-entry size cap. */
function encodeValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined) throw new HttpError(400, "value is required");
  if (value === null) return Prisma.JsonNull;
  const json = JSON.stringify(value);
  if (json === undefined) throw new HttpError(400, "value must be JSON-serializable");
  if (Buffer.byteLength(json) > MAX_VALUE_BYTES) throw new HttpError(413, "value exceeds 64KB");
  return value as Prisma.InputJsonValue;
}

export async function kvRead(appId: string, scope: string, key: string): Promise<unknown> {
  assertKey(key);
  const row = await prisma.appKv.findUnique({
    where: { appId_scope_key: { appId, scope, key } },
    select: { value: true },
  });
  return row ? row.value : null;
}

export async function kvWrite(appId: string, scope: string, key: string, value: unknown): Promise<void> {
  assertKey(key);
  const encoded = encodeValue(value);
  await prisma.appKv.upsert({
    where: { appId_scope_key: { appId, scope, key } },
    create: { appId, scope, key, value: encoded },
    update: { value: encoded },
  });
}

export async function kvDelete(appId: string, scope: string, key: string): Promise<boolean> {
  assertKey(key);
  const deleted = await prisma.appKv.deleteMany({ where: { appId, scope, key } });
  return deleted.count > 0;
}

/** `GET|PUT|DELETE /_pyre/kv/:key` — per-user scope, requires a session. */
export async function kvUserRoute(ctx: HostContext, req: Request, res: Response, key: string): Promise<void> {
  const user = await currentUser(req, ctx.app.id);
  if (!user) throw new HttpError(401, "sign in required");
  const scope = `user:${user.id}`;
  if (req.method === "GET" || req.method === "HEAD") {
    res.json({ value: await kvRead(ctx.app.id, scope, key) });
    return;
  }
  if (req.method === "PUT") {
    const body = await readJson(req, MAX_VALUE_BYTES + 4096);
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("value" in body)) {
      throw new HttpError(400, 'body must be {"value": <json>}');
    }
    await kvWrite(ctx.app.id, scope, key, body.value);
    res.json({ ok: true });
    return;
  }
  if (req.method === "DELETE") {
    await kvDelete(ctx.app.id, scope, key);
    res.json({ ok: true });
    return;
  }
  res.setHeader("Allow", "GET, PUT, DELETE");
  throw new HttpError(405, "method not allowed");
}

/** `GET /_pyre/kv/app/:key` — shared app scope, public read. Writes happen inside functions only. */
export async function kvAppRoute(ctx: HostContext, req: Request, res: Response, key: string): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET");
    throw new HttpError(405, "app scope is read-only over HTTP");
  }
  res.json({ value: await kvRead(ctx.app.id, APP_SCOPE, key) });
}
