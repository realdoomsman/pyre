import { Router, raw } from "express";
import { prisma } from "@pyre/db";
import { requireAuth } from "../lib/auth.js";
import { HttpError, wrap } from "../lib/errors.js";
import { env } from "../env.js";

/** Image types PONS and wallets render reliably; static keyed lookup per ts-set-map. */
export const ALLOWED_IMAGE_MIME: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
  "image/gif": true,
};

/** PONS coin art is tiny; 5 MB is generous and matches the launch form's client-side guard. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Identify an image by its magic bytes so a mislabeled or corrupt upload is caught before we store it.
 * Returns the true MIME, or null when the bytes are not a format we accept.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "image/webp";
  return null;
}

export const uploads = Router();

/**
 * Store a launcher's coin image and return a hosted URL usable as the coin logo on PONS. The body
 * is the raw file (content-type = its MIME): simpler than multipart and clear of the 2 MB JSON limit.
 * Bytes live in Postgres and are served back by GET below — no IPFS/CDN key to configure, so uploads
 * work out of the box. Auth-gated so only a signed-in launcher can spend storage.
 */
uploads.post(
  "/coin-image",
  requireAuth,
  raw({ type: () => true, limit: MAX_IMAGE_BYTES + 64 * 1024 }),
  wrap(async (req, res) => {
    const declared = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME[declared]) throw new HttpError(415, "unsupported_image_type");
    const buf: unknown = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, "not_an_image");
    if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, "image_too_large");
    const mime = sniffImageMime(buf);
    if (!mime) throw new HttpError(400, "not_an_image");
    const up = await prisma.upload.create({ data: { mime, data: new Uint8Array(buf), size: buf.length } });
    res.json({ url: `${env.API_ORIGIN}/v1/uploads/${up.id}` });
  }),
);

/** Serve a stored image — public, immutable, cross-origin so PONS and wallets can fetch it. */
uploads.get(
  "/:id",
  wrap(async (req, res) => {
    const up = await prisma.upload.findUnique({ where: { id: req.params.id! } });
    if (!up) throw new HttpError(404, "not_found");
    res.setHeader("Content-Type", up.mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.end(Buffer.from(up.data));
  }),
);
