import { env } from "../env.js";
import type { ApiError } from "./types.js";

/** Platform session JWT lives here; sent as `Authorization: Bearer <token>` on every request. */
export const SESSION_KEY = "pyre_session";

export const getSessionToken = (): string | null => {
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
};

export const setSessionToken = (token: string): void => {
  try {
    window.localStorage.setItem(SESSION_KEY, token);
  } catch {
    /* storage blocked (private mode); in-memory session only */
  }
};

export const clearSessionToken = (): void => {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
};

export class HttpError extends Error implements ApiError {
  status: number;
  error: string;
  /** Parsed JSON error body when the server sent one, so callers can read structured fields (e.g. `needBaseUnits`). */
  body: unknown;
  constructor(status: number, error: string, body?: unknown) {
    super(error);
    this.status = status;
    this.error = error;
    this.body = body ?? null;
  }
}

export const isHttpError = (e: unknown): e is HttpError => e instanceof HttpError;

const FALLBACK_ERRORS: Record<number, string> = {
  401: "sign in required",
  403: "not allowed",
  404: "not found",
  429: "rate limited — try again shortly",
};

const request = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = getSessionToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${env.apiOrigin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new HttpError(0, e instanceof Error && e.name === "AbortError" ? "aborted" : "network error — API unreachable");
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    let msg: string | null = null;
    if (json && typeof json === "object" && "error" in json && typeof json.error === "string") msg = json.error;
    throw new HttpError(res.status, msg ?? FALLBACK_ERRORS[res.status] ?? `request failed (${res.status})`, json);
  }
  return json as T;
};

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/** Uploads a coin image to the API (auth required); returns the hosted `/v1/uploads/<id>` URL. */
export const uploadCoinImage = async (file: File): Promise<string> => {
  const token = getSessionToken();
  const headers: Record<string, string> = { accept: "application/json", "content-type": file.type };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${env.apiOrigin}/v1/uploads/coin-image`, { method: "POST", headers, body: file });
  } catch {
    throw new HttpError(0, "network error — API unreachable");
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const msg = json && typeof json === "object" && "error" in json && typeof json.error === "string" ? json.error : null;
    throw new HttpError(res.status, msg ?? FALLBACK_ERRORS[res.status] ?? `upload failed (${res.status})`, json);
  }
  if (json && typeof json === "object" && "url" in json && typeof json.url === "string") return json.url;
  throw new HttpError(500, "bad_upload_response");
};

export const qs = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const parts: string[] = [];
  for (const k in params) {
    const v = params[k];
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
};
