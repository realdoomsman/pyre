import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as core from "./core.js";
import { pyreEnv } from "./env.js";
import { PyreError } from "./errors.js";
import { formatUsdg } from "./payment.js";
import type { AdCreative, HolderStatus, MeResult, PaidResult, PyreUser } from "./types.js";

const NO_SESSION: MeResult = {
  user: null,
  holder: { isHolder: false, balance: "0", minHold: "0" },
  purchases: [],
};

const BUTTON_STYLE: CSSProperties = {
  appearance: "none",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: "0.5rem",
  background: "#111114",
  color: "#f4f4f5",
  font: "inherit",
  fontWeight: 600,
  padding: "0.5rem 0.9rem",
  cursor: "pointer",
};

export interface PyreContextValue {
  /** The app's own user record, or `null` when nobody is logged in. */
  user: PyreUser | null;
  holder: HolderStatus;
  /** Product ids the user already paid for. */
  purchases: string[];
  /** True until `/_pyre/me` has answered once. */
  loading: boolean;
  /** Runs Google sign-in and establishes the app session. */
  login: () => Promise<void>;
  /** Clears the app session cookie. */
  logout: () => Promise<void>;
  /** Pays for a product from `pyre.manifest.json` in USDG via the user's custodial Pyre wallet. */
  charge: (productId: string) => Promise<PaidResult>;
  /** Re-reads `/_pyre/me`. */
  refresh: () => Promise<void>;
}

const PyreContext = createContext<PyreContextValue | null>(null);

export function usePyre(): PyreContextValue {
  const value = useContext(PyreContext);
  if (!value) {
    throw new PyreError("usePyre() requires an enclosing <PyreProvider> (usually rendered in src/main.tsx)", {
      code: "no_provider",
    });
  }
  return value;
}

interface AppSession {
  session: MeResult;
  setSession: (next: MeResult) => void;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Loads `/_pyre/me` once on mount and exposes helpers to refresh or overwrite it. */
function useAppSession(): AppSession {
  const [session, setSession] = useState<MeResult>(NO_SESSION);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setSession(await core.me());
  }, []);

  useEffect(() => {
    let cancelled = false;
    core
      .me()
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { session, setSession, loading, refresh };
}

/**
 * Wraps the app in the Pyre session: in-app Google sign-in and custodial USDG payments on Robinhood
 * Chain. The platform holds every user's wallet and signs on their behalf, so the browser never
 * touches a transaction. Render it once, around the whole tree.
 */
export function PyreProvider({ children }: { children: ReactNode }): ReactNode {
  const { session, setSession, loading, refresh } = useAppSession();

  const login = useCallback(async () => {
    await core.login();
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await core.logout();
    setSession(NO_SESSION);
  }, [setSession]);

  const charge = useCallback(
    async (productId: string): Promise<PaidResult> => {
      const paid = await core.charge(productId);
      setSession(await core.me());
      return paid;
    },
    [setSession],
  );

  const value = useMemo<PyreContextValue>(
    () => ({
      user: session.user,
      holder: session.holder,
      purchases: session.purchases,
      loading,
      login,
      logout,
      charge,
      refresh,
    }),
    [session, loading, login, logout, charge, refresh],
  );

  return <PyreContext.Provider value={value}>{children}</PyreContext.Provider>;
}

export interface LoginButtonProps {
  className?: string;
  /** Label while logged out. Defaults to "Log in". */
  children?: ReactNode;
}

/** Login / logout button. Shows the logged-in user's name once a session exists. */
export function LoginButton({ className, children }: LoginButtonProps): ReactNode {
  const { user, login, logout, loading } = usePyre();
  const style = className ? undefined : BUTTON_STYLE;

  if (loading) {
    return (
      <button type="button" className={className} style={style} disabled>
        …
      </button>
    );
  }
  if (user) {
    const label = user.displayName ?? (user.wallet ? `${user.wallet.slice(0, 4)}…${user.wallet.slice(-4)}` : "Account");
    return (
      <button type="button" className={className} style={style} onClick={() => void logout()} title="Log out">
        {label} · Log out
      </button>
    );
  }
  return (
    <button type="button" className={className} style={style} onClick={() => void login()}>
      {children ?? "Log in"}
    </button>
  );
}

export interface HolderGateProps {
  /** Whole tokens required. Defaults to the app's configured holder tier. */
  min?: bigint | number | string;
  /** Rendered instead of `children` when the gate is closed. Defaults to a "Get $TICKER on PONS" link. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Renders `children` only for users holding enough of the app's coin (`pyreEnv().tokenAddress`).
 * Before the coin is launched — and on local dev hosts — nobody can hold it, so the gate stays
 * closed and shows the fallback.
 */
export function HolderGate({ min, fallback, children }: HolderGateProps): ReactNode {
  const { holder, loading } = usePyre();
  if (loading) return null;

  const env = pyreEnv();
  const required = min === undefined ? holder.minHold : min;
  let threshold: bigint;
  try {
    threshold = BigInt(required);
  } catch {
    throw new PyreError(`<HolderGate min> must be an integer token amount, got ${String(required)}`, {
      code: "bad_prop",
    });
  }
  const passes = env.tokenAddress !== "" && BigInt(holder.balance) >= threshold && (threshold > 0n || holder.isHolder);
  if (passes) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  if (env.tokenAddress === "") return null;
  const coin = env.ticker ? `$${env.ticker}` : "the coin";
  const amount = threshold > 0n ? `${threshold.toLocaleString("en-US")} ` : "";
  return (
    <a href={`https://www.ponsfamily.com/launchpad/${env.tokenAddress}`} target="_blank" rel="noopener noreferrer">
      Hold {amount}{coin} to unlock
    </a>
  );
}

export interface AdSlotProps {
  className?: string;
}

const AD_STYLE: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "center",
  padding: "0.75rem",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "0.75rem",
  color: "inherit",
  textDecoration: "none",
};

/**
 * One billed ad impression from the Pyre ad network. Renders nothing when the
 * manifest has `adSlot: false` or no campaign is available.
 */
export function AdSlot({ className }: AdSlotProps): ReactNode {
  const [creative, setCreative] = useState<AdCreative | null>(null);

  useEffect(() => {
    let cancelled = false;
    core
      .ad()
      .then((next) => {
        if (!cancelled) setCreative(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!creative) return null;
  return (
    <a
      className={className}
      href={creative.clickUrl}
      rel="noopener noreferrer sponsored"
      target="_blank"
      style={className ? undefined : AD_STYLE}
    >
      {creative.imageUrl ? (
        <img src={creative.imageUrl} alt="" width={48} height={48} style={{ borderRadius: "0.5rem" }} />
      ) : null}
      <span>
        <strong style={{ display: "block" }}>{creative.headline}</strong>
        <span style={{ opacity: 0.7 }}>{creative.body}</span>
      </span>
    </a>
  );
}

export interface CheckoutProps {
  /** Product id from `pyre.manifest.json`. */
  productId: string;
  onPaid?: (result: PaidResult) => void;
  className?: string;
  /** Button label. Defaults to the product name and price from the manifest. */
  children?: ReactNode;
}

/** Buy button: hosted USDG checkout charged to the user's custodial Pyre wallet server-side. */
export function Checkout({ productId, onPaid, className, children }: CheckoutProps): ReactNode {
  const { charge, purchases, user, login, loading } = usePyre();
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const product = pyreEnv().products?.find((p) => p.id === productId);
  const owned = paid || purchases.includes(productId);

  const buy = async (): Promise<void> => {
    setError(null);
    setPaying(true);
    try {
      const result = await charge(productId);
      setPaid(true);
      onPaid?.(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPaying(false);
    }
  };

  const price = product ? `$${formatUsdg(BigInt(Math.round(product.priceUsd * 1_000_000)))}` : null;
  const label = children ?? (product ? `${product.name}${price ? ` · ${price}` : ""}` : `Buy ${productId}`);

  if (!user && !loading) {
    return (
      <button type="button" className={className} style={className ? undefined : BUTTON_STYLE} onClick={() => void login()}>
        Log in to buy
      </button>
    );
  }

  return (
    <span>
      <button
        type="button"
        className={className}
        style={className ? undefined : BUTTON_STYLE}
        disabled={owned || paying || loading}
        onClick={() => void buy()}
      >
        {owned ? "Purchased" : paying ? "Confirming payment…" : label}
      </button>
      {error ? (
        <span role="alert" style={{ display: "block", marginTop: "0.4rem", color: "#f87171" }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
