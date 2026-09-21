import { PyreError } from "./errors.js";
import type { PyreEnv } from "./types.js";

declare global {
  interface Window {
    __PYRE__?: PyreEnv;
  }
}

/**
 * Fields the SDK cannot work without. `googleClientId`, `treasury` and `tokenAddress` are
 * deliberately absent: a local `vite dev`/`vite preview` host leaves them empty, and the SDK then
 * runs without Google sign-in / payments / holder gating instead of crashing the app.
 */
const REQUIRED: readonly (keyof PyreEnv)[] = ["appId", "slug", "usdg"];

let cached: PyreEnv | null = null;

/**
 * The host injects `<script src="/_pyre/env.js">` before `</head>`, which assigns
 * `window.__PYRE__`. Anything importing the SDK outside a hosted Pyre app gets a
 * loud error instead of silent `undefined` dereferences.
 */
export function pyreEnv(): PyreEnv {
  if (cached) return cached;
  const raw = typeof window === "undefined" ? undefined : window.__PYRE__;
  if (!raw) {
    throw new PyreError(
      "window.__PYRE__ is missing — @pyre/app-sdk only runs inside an app hosted on Pyre, " +
        'where the platform injects <script src="/_pyre/env.js"></script>. ' +
        "Locally, `npm run dev` / `npm run preview` provide it via dev/pyre-local-host.ts.",
      { code: "env_missing" },
    );
  }
  const missing = REQUIRED.filter((k) => typeof raw[k] !== "string" || raw[k] === "");
  if (missing.length > 0) {
    throw new PyreError(`window.__PYRE__ is incomplete — missing: ${missing.join(", ")}`, {
      code: "env_incomplete",
    });
  }
  // `basePath` is "" on subdomain hosting; normalise a trailing slash away so URL joins stay simple.
  cached = {
    ...raw,
    basePath: (raw.basePath ?? "").replace(/\/+$/, ""),
    chainId: raw.chainId ?? 4663,
    googleClientId: raw.googleClientId ?? "",
    treasury: raw.treasury ?? "",
    tokenAddress: raw.tokenAddress ?? "",
    explorerUrl: (raw.explorerUrl ?? "https://robinhoodchain.blockscout.com").replace(/\/+$/, ""),
    apiOrigin: raw.apiOrigin ?? "",
  };
  return cached;
}

/** True when the page was served by the Pyre host, i.e. the SDK can be used. */
export function hasPyreEnv(): boolean {
  return typeof window !== "undefined" && !!window.__PYRE__;
}

/** Absolute-on-origin URL for a platform endpoint, e.g. `/a/my-app/_pyre/me`. */
export function pyreUrl(path: string): string {
  const env = pyreEnv();
  return `${env.basePath}${path.startsWith("/") ? path : `/${path}`}`;
}
