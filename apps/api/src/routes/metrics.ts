import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { env } from "../env.js";
import { HttpError, wrap } from "../lib/errors.js";
import { renderMetrics } from "../lib/metrics.js";

export const metrics = Router();

/** Fixed-width digest compare: the secret's length must not leak through the comparison. */
const SECRET_DIGEST = createHash("sha256").update(env.INTERNAL_SECRET).digest();

metrics.get(
  "/",
  wrap(async (req, res) => {
    const authorization = req.headers.authorization;
    const token = authorization?.startsWith("Bearer ") === true ? authorization.slice(7).trim() : "";
    if (!timingSafeEqual(createHash("sha256").update(token).digest(), SECRET_DIGEST)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="metrics"');
      throw new HttpError(401, "unauthorized");
    }
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(await renderMetrics());
  }),
);
