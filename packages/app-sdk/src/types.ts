/** Wire types shared by the framework-free core and the React bindings. */

/** Runtime configuration the host injects as `window.__PYRE__` via `<script src="/_pyre/env.js">`. */
export interface PyreEnv {
  /** Pyre app id (cuid). */
  appId: string;
  /** URL slug the app is served under. */
  slug: string;
  /** EVM chain id every payment settles on: Robinhood Chain, `4663`. */
  chainId: number;
  /** USDG (Global Dollar) ERC-20 contract on Robinhood Chain — the currency of every payment; 6 decimals. */
  usdg: string;
  /** Platform treasury address — the recipient of checkout and x402 payments. Empty on local dev/preview hosts. */
  treasury: string;
  /** The app's coin (PONS v2 launch token, 18 decimals). Empty until the coin is launched and on local hosts. */
  tokenAddress: string;
  /** Blockscout explorer origin for Robinhood Chain (`/tx/<hash>`, `/token/<address>`). */
  explorerUrl: string;
  /** Google OAuth web client id used for in-app sign-in. Empty on local dev/preview hosts. */
  googleClientId: string;
  /**
   * Prefix every `/_pyre/*` request has to carry. `""` when the app is served on its own
   * subdomain, `"/a/<slug>"` when it is path-routed. Never has a trailing slash.
   */
  basePath: string;
  /** Origin of the Pyre platform API (for links back to the coin page). */
  apiOrigin: string;
  /** Display name of the app. */
  name?: string;
  /** Coin ticker of the app. */
  ticker?: string;
  /** Live deployment version. */
  version?: number;
  /** Whole tokens required for holder-gated features. */
  holderMin?: string | number;
  /** Whether `pyre.manifest.json` enables the ad slot. */
  adSlot?: boolean;
  /** Products declared in `pyre.manifest.json`. */
  products?: PyreProduct[];
  /** Server functions declared in `pyre.manifest.json`. */
  functions?: PyreFunction[];
}

export interface PyreProduct {
  id: string;
  name: string;
  priceUsd: number;
  kind: "ONE_TIME" | "SUBSCRIPTION_MONTHLY";
}

export interface PyreFunction {
  name: string;
  priceUsd: number;
  auth: boolean;
  holderOnly: boolean;
}

export interface PyreUser {
  id: string;
  /** Custodial Robinhood Chain address (0x) the platform holds for this user. */
  wallet: string | null;
  displayName: string | null;
}

export interface HolderStatus {
  isHolder: boolean;
  /** Whole tokens held, as a decimal string. */
  balance: string;
  /** Whole tokens required to pass the holder gate. */
  minHold: string;
}

export interface MeResult {
  user: PyreUser | null;
  holder: HolderStatus;
  /** Product ids the current user has already paid for. */
  purchases: string[];
}

/** Result of a successful `POST /_pyre/checkout`. */
export interface PaidResult {
  status: "PAID";
  /** ISO timestamp a subscription runs out at; `null` for one-time products. */
  expiresAt: string | null;
  /** Robinhood Chain transaction hash of the USDG transfer. */
  txHash: string;
}

/** Response of `GET /_pyre/ad`; `null` when no campaign is available (204). */
export interface AdCreative {
  /** Campaign id. */
  id: string;
  headline: string;
  body: string;
  imageUrl: string | null;
  /** Click-through URL on the app origin, already prefixed with `basePath`. */
  clickUrl: string;
}
