/** Any failure raised by the SDK. `status` is `0` for client-side failures. */
export class PyreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, opts: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "PyreError";
    this.status = opts.status ?? 0;
    this.code = opts.code ?? "pyre_error";
  }
}

/** The user has to be logged in (or the session expired). */
export class NotAuthenticatedError extends PyreError {
  constructor(message = "not authenticated") {
    super(message, { status: 401, code: "not_authenticated" });
    this.name = "NotAuthenticatedError";
  }
}
