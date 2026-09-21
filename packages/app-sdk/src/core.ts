import { hasPyreEnv, pyreEnv, pyreUrl } from "./env.js";
import { NotAuthenticatedError, InsufficientFundsError, PyreError } from "./errors.js";
import type { AdCreative, HolderStatus, MeResult, PaidResult, PyreUser } from "./types.js";

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
  if (res.status === 402) {
    return new InsufficientFundsError(
      typeof record.priceUsd === "number" ? record.priceUsd : null,
      typeof record.balanceUsd === "number" ? record.balanceUsd : null,
      typeof record.depositAddress === "string" ? record.depositAddress : null,
    );
  }
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
    purchases: Array.isArray(body.purchases) ? body.purchases.filter((p): p is string => typeof p === "string") : [],
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
 * Calls `functions/<name>.js` on the platform. Priced functions charge the caller's custodial
 * wallet in USDG on the server; a `402` (not enough USDG) surfaces as `InsufficientFundsError`.
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

/**
 * Buys a product from `pyre.manifest.json`. The platform charges the user's custodial wallet in
 * USDG on Robinhood Chain server-side; the browser never signs. A `402` surfaces as
 * `InsufficientFundsError`.
 */
export async function charge(productId: string): Promise<PaidResult> {
  const body = asRecord(await json("/_pyre/checkout", { method: "POST", body: { productId } }), "checkout");
  const purchase = asRecord(body.purchase, "checkout purchase");
  if (purchase.status !== "PAID") {
    throw new PyreError(`purchase is ${String(purchase.status ?? "unconfirmed")}`, { code: "not_paid" });
  }
  return {
    status: "PAID",
    expiresAt: typeof purchase.expiresAt === "string" ? purchase.expiresAt : null,
    txHash: typeof purchase.txHash === "string" ? purchase.txHash : "",
  };
}

/** Endpoint that serves (and bills) one ad impression. `<AdSlot/>` fetches it. */
export function adUrl(): string {
  return pyreUrl("/_pyre/ad");
}

/** Fetches an ad creative, or `null` when no campaign is available / the slot is off. */
export async function ad(): Promise<AdCreative | null> {
  const env = pyreEnv();
  if (env.adSlot === false) return null;
  const res = await send("/_pyre/ad");
  if (res.status === 204 || res.status === 404) return null;
  const body = await bodyOf(res);
  if (!res.ok) throw failure(res, body);
  if (body === null) return null;
  const record = asRecord(body, "GET /_pyre/ad");
  if (typeof record.id !== "string" || typeof record.clickUrl !== "string") return null;
  return {
    id: record.id,
    headline: String(record.headline ?? ""),
    body: String(record.body ?? ""),
    imageUrl: typeof record.imageUrl === "string" ? record.imageUrl : null,
    clickUrl: record.clickUrl,
  };
}

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
  login,
  exchange,
  logout,
  charge,
  ad,
  adUrl,
  track,
};

// Impression/user counting is a load-time signal; a failure here must never break the app.
if (hasPyreEnv()) void track().catch(() => undefined);
