import { useCallback, useEffect, useState } from "react";
import { GoogleLogin, GoogleOAuthProvider } from "@react-oauth/google";
import type { CredentialResponse } from "@react-oauth/google";
import { api } from "../api/client.js";
import type { AuthResponse, WalletChallenge } from "../api/types.js";
import { env } from "../env.js";
import { connectWallet, discoverWallets, signMessage, type WalletOption } from "../lib/wallet.js";
import { Button, Sheet, Skeleton } from "../ui/index.js";
import type { SignInSheetProps } from "./AuthProvider.js";

const IconWallet = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <rect x="1.5" y="3.5" width="13" height="9" rx="2" stroke="currentColor" strokeWidth="1.4" />
    <path d="M10 8h4.5" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="10.5" cy="8" r="1" fill="currentColor" />
  </svg>
);

/**
 * Two ways in. Google gives a custodial wallet the server signs for; an
 * injected wallet (EIP-6963) signs a SIWE (EIP-4361) challenge with `personal_sign`
 * and then signs its own trades. Both end in the same platform session.
 */
export const SignInSheet = ({ open, onClose, onSession }: SignInSheetProps) => {
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setWallets(null);
    let cancelled = false;
    void discoverWallets().then((list) => {
      if (!cancelled) setWallets(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onGoogle = useCallback(
    async (resp: CredentialResponse) => {
      if (!resp.credential) return;
      setError(null);
      setPending("google");
      try {
        const { token } = await api.post<AuthResponse>("/v1/auth/google", { credential: resp.credential });
        await onSession(token);
      } catch (e) {
        setError(e instanceof Error ? e.message : "sign-in failed");
      } finally {
        setPending(null);
      }
    },
    [onSession],
  );

  const onWallet = useCallback(
    async (w: WalletOption) => {
      setError(null);
      setPending(w.uuid);
      try {
        const address = await connectWallet(w.provider);
        const { message } = await api.post<WalletChallenge>("/v1/auth/wallet/challenge", { address });
        const signature = await signMessage(w.provider, address, message);
        const { token } = await api.post<AuthResponse>("/v1/auth/wallet/verify", { address, signature });
        await onSession(token, { address, provider: w.provider });
      } catch (e) {
        setError(e instanceof Error ? e.message : "wallet sign-in failed");
      } finally {
        setPending(null);
      }
    },
    [onSession],
  );

  return (
    <Sheet open={open} onClose={onClose} title="Sign in" eyebrow="account">
      <div className="flex flex-col gap-5">
        <p className="small text-ink-2">
          sign in with google and pyre keeps a wallet for you — every launch, trade and claim is signed server-side. or
          sign in with a wallet you already hold on {env.chainName}; it signs the login and your own trades.
        </p>

        <section aria-labelledby="signin-google">
          <div id="signin-google" className="eyebrow mb-2">
            google
          </div>
          <GoogleOAuthProvider clientId={env.googleClientId}>
            <div className="flex justify-start">
              <GoogleLogin
                onSuccess={onGoogle}
                onError={() => setError("google sign-in was cancelled")}
                theme="filled_black"
                text="signin_with"
                shape="pill"
                width="320"
              />
            </div>
          </GoogleOAuthProvider>
        </section>

        <section aria-labelledby="signin-wallet">
          <div id="signin-wallet" className="eyebrow mb-2">
            wallet · {env.chainName}
          </div>
          {wallets === null ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : wallets.length === 0 ? (
            <p className="small rounded-control border border-dashed border-line px-3 py-3 text-ink-3">
              no browser wallet found. install one that speaks EIP-6963 (rabby, metamask, coinbase wallet) and reload.
            </p>
          ) : (
            <ul className="space-y-2">
              {wallets.map((w) => (
                <li key={w.uuid}>
                  <Button
                    variant="secondary"
                    size="md"
                    className="w-full justify-start"
                    loading={pending === w.uuid}
                    disabled={pending !== null && pending !== w.uuid}
                    onClick={() => void onWallet(w)}
                    iconLeft={w.icon ? <img src={w.icon} alt="" width={18} height={18} className="rounded-[4px]" /> : <IconWallet />}
                  >
                    sign in with {w.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error && (
          <p className="small text-burn" role="alert">
            {error}
          </p>
        )}
        <p className="micro text-ink-3">
          by signing in you agree to the terms and the content policy. coins are not investments; apps can fail.
        </p>
      </div>
    </Sheet>
  );
};
