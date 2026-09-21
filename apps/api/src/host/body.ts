import type { Request } from "express";
import { HttpError } from "../lib/errors.js";

/** Reads and parses a JSON body. Empty bodies parse as `{}`. Throws HttpError(413|400). */
export async function readJson(req: Request, limitBytes = 64 * 1024): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limitBytes) throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new HttpError(413, "body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}
