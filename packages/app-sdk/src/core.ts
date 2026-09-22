import { hasPyreEnv, pyreEnv, pyreUrl } from "./env.js";
import { NotAuthenticatedError, PyreError } from "./errors.js";
import type { HolderStatus, MeResult, PyreUser } from "./types.js";

interface SendOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PyreError(`${what} did not return a JSON object`, { code: "bad_response" });
  }
  return value as Record<string, unknown>;
}

async function send(path: string, opts: SendOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  const init: RequestInit = {
    method: opts.method ?? "GET",
    credentials: "include",
    headers,
  };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  try {
    return await fetch(pyreUrl(path), init);
  } catch (cause) {
    throw new PyreError(`request to ${path} failed: the platform is unreachable`, { code: "network", cause });
  }
}

async function bodyOf(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PyreError(`${res.url} returned a non-JSON body (${res.status})`, {
      status: res.status,
      code: "bad_response",
    });
  }
}

/** Turns a non-2xx `{error}` response into the narrowest error class we have. */
function failure(res: Response, body: unknown): PyreError {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const message = typeof record.error === "string" ? record.error : `request failed with status ${res.status}`;
  if (res.status === 401) return new NotAuthenticatedError(message);
  return new PyreError(message, { status: res.status, code: `http_${res.status}` });
}

async function json(path: string, opts: SendOpts = {}): Promise<unknown> {
  const res = await send(path, opts);
  const body = await bodyOf(res);
  if (!res.ok) throw failure(res, body);
  return body;
}

/** A user record straight off the wire; anything without an `id` counts as "no session". */
function parseUser(raw: unknown): PyreUser | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const u = asRecord(raw, "user");
  if (typeof u.id !== "string") return null;
  return {
    id: u.id,
    wallet: typeof u.wallet === "string" ? u.wallet : null,
    displayName: typeof u.displayName === "string" ? u.displayName : null,
  };
}

export async function me(): Promise<MeResult> {
  const body = asRecord(await json("/_pyre/me"), "GET /_pyre/me");
  const holderRecord = asRecord(body.holder ?? {}, "GET /_pyre/me holder");
  return {
    user: parseUser(body.user),
    holder: {
      isHolder: holderRecord.isHolder === true,
      balance: String(holderRecord.balance ?? "0"),
      minHold: String(holderRecord.minHold ?? "0"),
    },
  };
}

export async function holder(): Promise<HolderStatus> {
  return (await me()).holder;
}

/** Per-user key/value storage. `app` is the app-wide namespace server functions write to. */
export const kv = {
  async get<T = unknown>(key: string): Promise<T | null> {
    const body = asRecord(await json(`/_pyre/kv/${encodeURIComponent(key)}`), "GET /_pyre/kv");
    // Stored JSON is opaque to the platform; the caller declares its own shape via `T`.
    const value = body.value as T | undefined;
    return value ?? null;
  },
  async set<T = unknown>(key: string, value: T): Promise<void> {
    await json(`/_pyre/kv/${encodeURIComponent(key)}`, { method: "PUT", body: { value } });
  },
  async del(key: string): Promise<void> {
    await json(`/_pyre/kv/${encodeURIComponent(key)}`, { method: "DELETE" });
  },
  /** Read-only from the browser: the app namespace is written by `functions/*.js`. */
  async app<T = unknown>(key: string): Promise<T | null> {
    const body = asRecord(await json(`/_pyre/kv/app/${encodeURIComponent(key)}`), "GET /_pyre/kv/app");
    const value = body.value as T | undefined;
    return value ?? null;
  },
};

/**
 * Calls `functions/<name>.js` on the platform. A function declared with `auth: true` answers
 * `401` (`NotAuthenticatedError`) for anonymous callers; `holderOnly: true` answers `403`.
 */
export async function fn<T = unknown>(name: string, input?: unknown): Promise<T> {
  const path = `/_pyre/fn/${encodeURIComponent(name)}`;
  const res = await send(path, { method: "POST", body: input ?? {} });
  const body = await bodyOf(res);
  if (!res.ok) throw failure(res, body);
  // The host wraps the handler's return value: `{ result: <value> }`. Its shape is the app's own contract.
  return asRecord(body, `POST ${path}`).result as T;
}

interface GoogleCredentialResponse {
  credential?: string;
}

interface GooglePromptNotification {
  isNotDisplayed?: () => boolean;
  isSkippedMoment?: () => boolean;
  isDismissedMoment?: () => boolean;
}

interface GoogleIdentity {
  initialize: (config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    use_fedcm_for_prompt?: boolean;
  }) => void;
  prompt: (listener?: (notification: GooglePromptNotification) => void) => void;
  cancel: () => void;
  disableAutoSelect: () => void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
const NO_GOOGLE =
  "google sign-in is unavailable — window.__PYRE__.googleClientId is empty. " +
  "It is injected by the Pyre host; login works on the deployed app.";

let gisLoad: Promise<GoogleIdentity> | null = null;

/** Loads Google Identity Services once and resolves its `google.accounts.id` API. */
function loadGoogleIdentity(): Promise<GoogleIdentity> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new PyreError("google sign-in requires a browser", { code: "no_window" }));
  }
  const existing = window.google?.accounts?.id;
  if (existing) return Promise.resolve(existing);
  if (gisLoad) return gisLoad;
  gisLoad = new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const api = window.google?.accounts?.id;
      if (api) resolve(api);
      else reject(new PyreError("Google Identity Services loaded without an id API", { code: "gis_load" }));
    };
    script.onerror = () => {
      gisLoad = null;
      reject(new PyreError("could not load Google Identity Services", { code: "gis_load" }));
    };
    document.head.appendChild(script);
  });
  return gisLoad;
}

/** Opens the Google sign-in prompt and resolves the returned ID token (JWT credential). */
async function requestGoogleCredential(clientId: string): Promise<string> {
  const id = await loadGoogleIdentity();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    id.initialize({
      client_id: clientId,
      callback: (response) => {
        if (settled) return;
        if (response?.credential) {
          settled = true;
          resolve(response.credential);
        } else {
          settled = true;
          reject(new PyreError("google sign-in returned no credential", { code: "google_login" }));
        }
      },
      use_fedcm_for_prompt: true,
    });
    id.prompt((notification) => {
      if (settled) return;
      if (notification.isNotDisplayed?.() || notification.isSkippedMoment?.() || notification.isDismissedMoment?.()) {
        settled = true;
        reject(new PyreError("google sign-in was dismissed", { code: "google_dismissed" }));
      }
    });
  });
}

/** Exchanges a Google ID token (JWT credential) for the app's `pyre_app_session` cookie. */
export async function exchange(credential: string): Promise<PyreUser> {
  const body = asRecord(await json("/_pyre/auth/exchange", { method: "POST", body: { credential } }), "exchange");
  const user = parseUser(body.user);
  if (!user) throw new PyreError("exchange did not return a user", { code: "bad_response" });
  return user;
}

/** Runs Google sign-in and trades the credential for the app session cookie. */
export async function login(): Promise<PyreUser> {
  const clientId = pyreEnv().googleClientId;
  if (!clientId) throw new PyreError(NO_GOOGLE, { code: "no_google" });
  const credential = await requestGoogleCredential(clientId);
  return exchange(credential);
}

/** Drops the app session cookie and clears any Google auto-select. */
export async function logout(): Promise<void> {
  window.google?.accounts?.id?.disableAutoSelect();
  await json("/_pyre/auth/logout", { method: "POST" });
}

/** One coin launched on Pyre, as the platform's public feed describes it (prices in USD, live). */
export interface PyreCoin {
  id: string;
  slug: string;
  name: string;
  ticker: string;
  imageUrl: string;
  tokenAddress: string | null;
  priceUsd: number;
  marketCapUsd: number;
  change24hPct: number;
  volume24hUsd: number;
  holdersCount: number;
  /** 0 = bonding curve, 2 = Uniswap v4 pool. */
  launchPhase: number;
  /** Curve progress 0..1. */
  progress: number;
  [extra: string]: unknown;
}

export interface PyreCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

/**
 * Live data about every coin on Pyre, served from the app's own origin (`/_pyre/coins`), so apps
 * can build on real prices, market caps and history without keys or CORS.
 */
export const coins = {
  list: (opts: { sort?: "trending" | "new" | "heating" | "graduated" | "shipping"; limit?: number; cursor?: string } = {}) =>
    json(`/_pyre/coins${qs({ sort: opts.sort, limit: opts.limit, cursor: opts.cursor })}`) as Promise<{ items: PyreCoin[]; nextCursor: string | null }>,
  get: async (slug: string) => ((await json(`/_pyre/coins/${encodeURIComponent(slug)}`)) as { app: PyreCoin }).app,
  candles: (slug: string, opts: { interval?: "1m" | "5m" | "15m" | "1h" | "4h" | "1d"; limit?: number } = {}) =>
    json(`/_pyre/coins/${encodeURIComponent(slug)}/candles${qs({ interval: opts.interval, limit: opts.limit })}`) as Promise<{ interval: string; candles: PyreCandle[]; supply: number }>,
};

let tracked = false;

/** Records one session for the app's user count. Runs once per page load. */
export async function track(): Promise<void> {
  if (tracked) return;
  tracked = true;
  await json("/_pyre/track", { method: "POST" });
}

/** Everything an app needs without React. Mirrors the named exports of this module. */
export const ship = {
  get env() {
    return pyreEnv();
  },
  me,
  holder,
  kv,
  fn,
  coins,
  login,
  exchange,
  logout,
  track,
};

// User counting is a load-time signal; a failure here must never break the app.
if (hasPyreEnv()) void track().catch(() => undefined);
