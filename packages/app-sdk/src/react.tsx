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
import type { HolderStatus, MeResult, PyreUser } from "./types.js";

const NO_SESSION: MeResult = {
  user: null,
  holder: { isHolder: false, balance: "0", minHold: "0" },
};

/** Pyre look for components rendered without a `className`: violet button, ink text. */
const BUTTON_STYLE: CSSProperties = {
  appearance: "none",
  border: "1px solid transparent",
  borderRadius: "8px",
  background: "#9D8CFF",
  color: "#0A0A0C",
  font: "inherit",
  fontWeight: 600,
  padding: "0.5rem 0.9rem",
  cursor: "pointer",
};

export interface PyreContextValue {
  /** The app's own user record, or `null` when nobody is logged in. */
  user: PyreUser | null;
  holder: HolderStatus;
  /** True until `/_pyre/me` has answered once. */
  loading: boolean;
  /** Runs Google sign-in and establishes the app session. */
  login: () => Promise<void>;
  /** Clears the app session cookie. */
  logout: () => Promise<void>;
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
 * Wraps the app in the Pyre session: in-app Google sign-in and holder status. The platform holds
 * every user's wallet, so the browser never touches a key or a transaction. Render it once, around
 * the whole tree.
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

  const value = useMemo<PyreContextValue>(
    () => ({
      user: session.user,
      holder: session.holder,
      loading,
      login,
      logout,
      refresh,
    }),
    [session, loading, login, logout, refresh],
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
    <a
      href={`https://www.ponsfamily.com/launchpad/${env.tokenAddress}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: "#9D8CFF" }}
    >
      Hold {amount}
      {coin} to unlock
    </a>
  );
}
