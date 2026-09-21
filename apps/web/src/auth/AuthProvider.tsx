import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { MeDto } from "@pyre/shared";
import type { Address } from "viem";
import { api, clearSessionToken, getSessionToken, isHttpError, setSessionToken } from "../api/client.js";
import type { EIP1193Provider as Eip1193Provider } from "viem";
import { setConnectedWallet } from "../lib/walletSession.js";

export interface ExternalWallet {
  address: Address;
  provider: Eip1193Provider;
}

export interface AuthState {
  ready: boolean;
  authenticated: boolean;
  user: MeDto | null;
  /** The user's custodial wallet address (server-held), or null before it exists. */
  wallet: Address | null;
  displayName: string | null;
  /** The injected wallet the user proved at sign-in, when they signed in with one. */
  externalWallet?: ExternalWallet;
  /** Open the sign-in sheet (Google or an injected wallet). */
  signIn: () => void;
  signOut: () => Promise<void>;
  /** Re-read `/v1/me` (after a trade, a withdrawal, a claim). */
  refresh: () => Promise<void>;
}

/** Props the lazily-loaded sign-in sheet needs to publish a new session upward. */
export interface SignInSheetProps {
  open: boolean;
  onClose: () => void;
  onSession: (token: string, external?: ExternalWallet) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/*
 * The sign-in sheet — Google Identity Services plus viem for the wallet
 * challenge — is loaded only when a visitor actually signs in. This dynamic
 * import is the code-split boundary: nothing else may import those packages
 * statically, so the home page and the share cards boot without them.
 */
const SignInSheet = lazy(async () => ({ default: (await import("./SignInSheet.js")).SignInSheet }));

/**
 * Self-hosted auth: a platform session JWT in localStorage (`pyre_session`),
 * validated against `/v1/me`. Custodial users never sign anything; external
 * wallet users sign the login challenge and, later, their own trades.
 */
export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<MeDto | null>(null);
  const [ready, setReady] = useState(() => !getSessionToken());
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [external, setExternal] = useState<ExternalWallet | undefined>(undefined);

  // Validate any stored session on first paint. A 401 means the token is stale
  // and must be cleared; any other failure is transient (5xx/network), so retry
  // once and otherwise keep the token rather than signing the user out.
  useEffect(() => {
    const token = getSessionToken();
    if (!token) {
      setReady(true);
      return;
    }
    let cancelled = false;
    const validate = async (): Promise<void> => {
      for (let attempt = 0; attempt < 2 && !cancelled; attempt++) {
        try {
          const me = await api.get<MeDto>("/v1/me");
          if (!cancelled) setUser(me);
          return;
        } catch (e) {
          if (isHttpError(e) && e.status === 401) {
            if (!cancelled) clearSessionToken();
            return;
          }
          if (attempt === 0) {
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, 1000);
            await promise;
          }
        }
      }
    };
    void validate().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSession = useCallback(async (token: string, wallet?: ExternalWallet) => {
    setSessionToken(token);
    setUser(await api.get<MeDto>("/v1/me"));
    setExternal(wallet);
    setConnectedWallet(wallet ?? null);
    setOpen(false);
  }, []);

  const signIn = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

  const signOut = useCallback(async () => {
    // Revoke server-side (bumps tokenVersion) while the bearer is still stored; best-effort so a
    // network blip still signs the user out locally.
    await api.post("/v1/auth/logout").catch(() => undefined);
    clearSessionToken();
    setConnectedWallet(null);
    setExternal(undefined);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!getSessionToken()) return;
    setUser(await api.get<MeDto>("/v1/me"));
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      authenticated: user !== null,
      user,
      wallet: user?.wallet ?? null,
      displayName: user?.user.displayName ?? null,
      externalWallet: external,
      signIn,
      signOut,
      refresh,
    }),
    [ready, user, external, signIn, signOut, refresh],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {mounted && (
        <Suspense fallback={null}>
          <SignInSheet open={open} onClose={() => setOpen(false)} onSession={onSession} />
        </Suspense>
      )}
    </AuthContext.Provider>
  );
};

export const useAuthState = (): AuthState => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("auth hooks must be used inside <AuthProvider>");
  return ctx;
};
