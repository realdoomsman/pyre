import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { logger } from "./logger.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Express 4 does not forward async rejections; every async route goes through this. */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const parse = <T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> => {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new HttpError(400, "validation_failed", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, status: err.status, ...err.extra });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "validation_failed",
      status: 400,
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  // body-parser / http-errors style errors carry a numeric `status`
  const status =
    err && typeof err === "object" && "status" in err && typeof err.status === "number" ? err.status : 500;
  if (status >= 500) logger.error({ err, path: req.path }, "unhandled error");
  res.status(status).json({
    error: status >= 500 ? "internal_error" : err instanceof Error ? err.message : "error",
    status,
  });
};
