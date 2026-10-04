import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Address as EvmAddress } from "viem";
import { REFUND_LINK_TTL_SECONDS, REFUND_SNAPSHOT, VENUES, type RefundHolderDto } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import { formatDate, formatEth, shortAddress } from "../../lib/format.js";
import { connectSolana, detectSolanaWallets, signSolanaMessage, toBase64, type SolanaProvider, type SolanaWalletOption } from "../../lib/solanaWallet.js";
import { ROBINHOOD, useVenueLinks } from "../../lib/venue.js";
import { Address, Button, Card, CardHeader, Chip, Skeleton, cx } from "../../ui/index.js";
import type { PickedEvmWallet } from "./EvmWalletPicker.js";
import { IconWallet } from "./IconWallet.js";
import { HOLDING_CHIP, holdingOf } from "./holding.js";
import { requestLinkChallenge, useLinkRefund, useRefundHolder } from "./hooks.js";

// Dynamic on purpose: the injected-wallet picker is the only part of /refund that needs `lib/wallet.ts`,
// and a static import would put viem's wallet stack (the `wallet-*` chunk) in this page's initial graph.
const EvmWalletPicker = lazy(async () => ({ default: (await import("./EvmWalletPicker.js")).EvmWalletPicker }));

/** The Robinhood Chain side: an injected wallet that signs, or the signed-in account's custodial wallet, proven by the session. */
type EvmChoice = ({ kind: "external" } & PickedEvmWallet) | { kind: "custodial"; address: EvmAddress };

interface SolChoice {
  name: string;
  pubkey: string;
  provider: SolanaProvider;
}

type Phase = "idle" | "challenge" | "evm" | "sol" | "link";

const isUserRejection = (e: unknown): boolean =>
  (typeof e === "object" && e !== null && "code" in e && e.code === 4001) || (e instanceof Error && /reject|declin|cancel/i.test(e.message));

/** Every error code `/v1/refund/link*` can answer with, in words a holder can act on. */
const explain = (e: unknown, custodial: boolean): string => {
  if (isUserRejection(e)) return "You declined in your wallet. Nothing was linked.";
  if (isHttpError(e)) {
    switch (e.error) {
      case "bad_address":
        return "That is not a valid Robinhood Chain address.";
      case "not_eligible":
        return `This address has nothing left to refund: it held no PYRE at block ${REFUND_SNAPSHOT.block}, never bought the PYRE it held, got back at least as much ETH as it put in, or sold or moved all its PYRE since.`;
      case "bad_sol_wallet":
        return "That Solana address is not a wallet account. Connect a regular Solana wallet and try again.";
      case "bad_evm_signature":
        return custodial
          ? "Your Pyre session does not own this address. Sign in again with the account that held the PYRE."
          : "The Robinhood Chain signature does not match this address. Sign with the wallet that held the PYRE.";
      case "bad_sol_signature":
        return "The Solana signature does not match the connected wallet. Reconnect it and try again.";
      case "challenge_expired":
        return `The request expired or was already used. Both signatures have to land within ${REFUND_LINK_TTL_SECONDS / 60} minutes; start again.`;
      case "rate_limited":
        return "Too many attempts. Wait a minute and try again.";
      case "validation_failed":
        return "The request was malformed. Reload the page and try again.";
      default:
        if (e.status === 0) return "Pyre could not be reached. Check your connection and try again.";
        return e.status >= 500 ? "Pyre had a problem just now. Nothing was linked; try again in a minute." : `Linking failed: ${e.message}.`;
    }
  }
  return e instanceof Error ? e.message : "Linking failed.";
};

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
  challenge: "Requesting the message…",
  evm: "Sign in your Robinhood Chain wallet…",
  sol: "Sign in your Solana wallet…",
  link: "Linking…",
};

export const LinkFlow = ({ live, onLinked }: { live: boolean; onLinked: (address: string) => void }) => {
  const auth = useAuth();
  const solana = useVenueLinks(VENUES.pump_fun);
  const [connecting, setConnecting] = useState(false);
  const [solWallets, setSolWallets] = useState<SolanaWalletOption[] | null>(null);
  const [evm, setEvm] = useState<EvmChoice | null>(null);
  const [sol, setSol] = useState<SolChoice | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState<RefundHolderDto | null>(null);
  const link = useLinkRefund();

  const custodialWallet = auth.authenticated ? auth.wallet : null;
  const custodialHolder = useRefundHolder(custodialWallet);
  const custodialEligible = custodialHolder.data !== undefined && BigInt(custodialHolder.data.eligibleWei) > 0n;
  const holder = useRefundHolder(evm?.address ?? null);
  const eligible = holder.data !== undefined && BigInt(holder.data.eligibleWei) > 0n;

  useEffect(() => {
    // Extensions inject at document start, but some land a beat after hydration: scan twice.
    setSolWallets(detectSolanaWallets());
    const t = window.setTimeout(() => setSolWallets(detectSolanaWallets()), 600);
    return () => window.clearTimeout(t);
  }, []);

  const reset = () => {
    setError(null);
    setLinked(null);
    setMessage(null);
  };

  const chooseSol = async (w: SolanaWalletOption) => {
    reset();
    setPending(w.id);
    try {
      const pubkey = await connectSolana(w.provider);
      setSol({ name: w.name, pubkey, provider: w.provider });
    } catch (e) {
      setError(explain(e, false));
    } finally {
      setPending(null);
    }
  };

  const run = async () => {
    if (!evm || !sol) return;
    reset();
    try {
      setPhase("challenge");
      const challenge = await requestLinkChallenge({ address: evm.address, solWallet: sol.pubkey });
      setMessage(challenge.message);
      let evmSignature: string | undefined;
      if (evm.kind === "external") {
        setPhase("evm");
        evmSignature = await evm.sign(challenge.message);
      }
      setPhase("sol");
      const solSignature = toBase64(await signSolanaMessage(sol.provider, challenge.message));
      setPhase("link");
      const result = await link.mutateAsync({ address: evm.address, solWallet: sol.pubkey, nonce: challenge.nonce, solSignature, ...(evmSignature ? { evmSignature } : {}) });
      setLinked(result);
      onLinked(result.address);
    } catch (e) {
      setError(explain(e, evm.kind === "custodial"));
    } finally {
      setPhase("idle");
    }
  };

  const busy = phase !== "idle" || pending !== null;
  const ready = evm !== null && sol !== null && eligible;

  return (
    <Card id="link" className="scroll-mt-24">
      <CardHeader
        eyebrow="Link payout wallet"
        title="Where your refund is paid"
        description={live ? "Refunds go to the Solana wallet you link here." : "Link now; payouts start once the Solana coin is live."}
      />
      <ol className="flex flex-col gap-3">
        <StepBlock n="1" title="Robinhood Chain wallet" done={evm !== null && eligible} active>
          {evm ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Address address={evm.address} chars={6} explorerUrl={ROBINHOOD.address(evm.address)} className="text-14" />
                <span className="small text-ink-3">{evm.kind === "custodial" ? "your Pyre wallet" : evm.name}</span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => (reset(), setEvm(null), setConnecting(false))}>
                  Change
                </Button>
              </div>
              <Eligibility query={holder} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="small text-ink-2">
                The wallet that held PYRE at the snapshot and still holds it. Connecting only reads the address; it moves nothing.
              </p>
              {custodialWallet && custodialEligible && (
                <Button
                  variant="primary"
                  className="w-full justify-start sm:w-auto sm:self-start"
                  disabled={busy}
                  onClick={() => (reset(), setEvm({ kind: "custodial", address: custodialWallet }))}
                  iconLeft={<IconWallet />}
                >
                  Use my Pyre wallet <span className="num">{shortAddress(custodialWallet)}</span>
                </Button>
              )}
              {connecting ? (
                <Suspense fallback={<Skeleton className="h-10 w-full sm:w-64" />}>
                  <EvmWalletPicker disabled={busy} onPick={(w) => (reset(), setEvm({ kind: "external", ...w }))} onError={(e) => setError(explain(e, false))} />
                </Suspense>
              ) : (
                <Button variant="secondary" className="w-full justify-start sm:w-auto sm:self-start" disabled={busy} onClick={() => (reset(), setConnecting(true))} iconLeft={<IconWallet />}>
                  Connect a wallet
                </Button>
              )}
              {!auth.authenticated && auth.ready && (
                <p className="small text-ink-3">
                  Held PYRE in your Pyre account?{" "}
                  <button type="button" onClick={auth.signIn} className="text-accent underline underline-offset-2">
                    Sign in
                  </button>{" "}
                  to use it without a wallet signature.
                </p>
              )}
            </div>
          )}
        </StepBlock>

        {!(evm !== null && !holder.isPending && !eligible) && (
          <>
            <StepBlock n="2" title="Solana wallet" done={sol !== null} active={evm !== null && eligible}>
              {sol ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Address address={sol.pubkey} chars={6} identicon={false} explorerUrl={solana.address(sol.pubkey)} className="text-14" />
                  <span className="small text-ink-3">{sol.name}</span>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => (reset(), setSol(null))}>
                    Change
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="small text-ink-2">Where the SOL is sent. It must be a wallet you control: you sign with it in the next step.</p>
                  {solWallets === null ? (
                    <Skeleton className="h-10 w-full sm:w-64" />
                  ) : solWallets.length === 0 ? (
                    <Notice>
                      No Solana wallet found in this browser. Install Phantom, Solflare or Backpack and reload. On a phone, open pyre.fun/refund in your wallet app's built-in browser.
                    </Notice>
                  ) : (
                    <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      {solWallets.map((w) => (
                        <li key={w.id}>
                          <Button
                            variant="secondary"
                            className="w-full justify-start sm:w-auto"
                            loading={pending === w.id}
                            disabled={!(evm !== null && eligible) || (busy && pending !== w.id)}
                            onClick={() => void chooseSol(w)}
                            iconLeft={<IconWallet />}
                          >
                            Connect {w.name}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </StepBlock>

            <StepBlock n="3" title="Sign and link" done={linked !== null} active={ready}>
              {linked ? (
                <div className="flex flex-col gap-1.5" role="status">
                  <p className="text-14 text-earn">Linked.</p>
                  <p className="small flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ink-2">
                    <span>Refunds owed to</span>
                    <Address address={linked.address} chars={4} copy={false} explorerUrl={null} className="text-13" />
                    <span>are paid to</span>
                    <span className="inline-flex items-center">
                      <Address address={linked.solWallet ?? sol?.pubkey ?? ""} chars={4} identicon={false} copy={false} explorerUrl={null} className="text-13" />.
                    </span>
                  </p>
                  {linked.linkPendingUntil ? (
                    <p className="small text-ink-3">
                      New payout wallet active from <span className="num">{formatDate(linked.linkPendingUntil)}</span>: a changed payout wallet waits 48 hours before it is paid, so a change you didn't make can be undone in time. Credit keeps accruing meanwhile.
                    </p>
                  ) : (
                    <p className="small text-ink-3">{live ? "The next payout run sends any credit waiting." : "Payouts start once the Solana coin is live."}</p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="small text-ink-2">
                    {evm?.kind === "custodial"
                      ? "Your Pyre session proves the Robinhood Chain address. You sign one short message with your Solana wallet."
                      : "You sign the same short message twice: once with your Robinhood Chain wallet, once with your Solana wallet."}{" "}
                    Signing moves no funds and costs no gas.
                  </p>
                  {message && (
                    <pre className="num max-w-full overflow-x-auto whitespace-pre-wrap rounded-control border border-line bg-mono-bg px-3 py-2 text-12 text-ink-2 [overflow-wrap:anywhere]">
                      {message}
                    </pre>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="primary" disabled={!ready || busy} loading={phase !== "idle"} onClick={() => void run()} className="w-full sm:w-auto">
                      Sign and link
                    </Button>
                    {phase !== "idle" && (
                      <span className="small text-ink-2" aria-live="polite">
                        {PHASE_LABEL[phase]}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </StepBlock>
          </>
        )}
      </ol>
      {error && (
        <p className="small mt-4 text-danger" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
};

const StepBlock = ({ n, title, done, active, children }: { n: string; title: string; done: boolean; active: boolean; children: ReactNode }) => (
  <li className={cx("rounded-card border px-4 py-4 transition-opacity", done ? "border-line" : active ? "border-line-2" : "border-line opacity-55")}>
    <div className="mb-3 flex items-center gap-3">
      <span
        className={cx(
          "num grid h-6 w-6 shrink-0 place-items-center rounded-pill border text-12",
          done ? "border-transparent bg-[color-mix(in_oklab,var(--color-earn)_18%,transparent)] text-earn" : "border-line-2 text-ink-2",
        )}
        aria-hidden
      >
        {done ? "✓" : n}
      </span>
      <h3 className="text-14 font-medium text-ink">
        <span className="sr-only">Step {n}: </span>
        {title}
      </h3>
    </div>
    {children}
  </li>
);

const Notice = ({ children }: { children: ReactNode }) => <p className="small rounded-control border border-dashed border-line px-3 py-3 text-ink-3">{children}</p>;

const Eligibility = ({ query }: { query: UseQueryResult<RefundHolderDto> }) => {
  if (query.isPending) return <Skeleton className="h-5 w-56" />;
  if (query.isError) {
    const e = query.error;
    return (
      <p className="small text-danger" role="alert">
        {isHttpError(e) && e.error === "not_eligible"
          ? `This address held no PYRE at block ${REFUND_SNAPSHOT.block}, so nothing is owed to it. Connect the wallet that held it.`
          : explain(e, false)}
      </p>
    );
  }
  const h = query.data;
  if (BigInt(h.owedWei) === 0n) {
    return (
      <p className="small text-ink-2">
        {BigInt(h.boughtUnits) === 0n
          ? "On the snapshot, but nothing is owed: this address never bought PYRE itself before the snapshot (what it held arrived by transfer). There is nothing to link."
          : "On the snapshot, but nothing is owed: this address got back at least as much ETH as it put in. There is nothing to link."}
      </p>
    );
  }
  const holding = holdingOf(h);
  const chip = HOLDING_CHIP[holding];
  if (holding === "soldOut") {
    return (
      <div className="small flex flex-col gap-1.5 text-ink-2">
        <Chip size="sm" mono tone={chip.tone} dot className="self-start">
          {chip.label}
        </Chip>
        <p>
          This address sold or moved all the PYRE it held at the snapshot, so its refund of {formatEth(h.owedWei)} is gone and there is nothing to link. Buying PYRE again doesn't
          restore it.
        </p>
      </div>
    );
  }
  return (
    <div className="small flex flex-col gap-1.5 text-ink-2">
      <Chip size="sm" mono tone={chip.tone} dot className="self-start">
        {chip.label}
      </Chip>
      <p>
        {holding === "reduced" && (
          <>
            Owed <span className="num text-ink-3 line-through">{formatEth(h.owedWei)}</span> ·{" "}
          </>
        )}
        Eligible <span className="num text-ink">{formatEth(h.eligibleWei)}</span> · remaining <span className="num text-ink">{formatEth(h.remainingWei)}</span>
      </p>
      <p className="text-ink-3">
        {holding === "reduced"
          ? "Cut because PYRE left this address after the snapshot. Selling or moving more cuts it further; buying back doesn't restore it."
          : "Keep holding: selling or moving any of it shrinks the refund for good."}
      </p>
      {h.solWallet && (
        <p className="text-ink-3">
          Currently paid to <span className="num">{shortAddress(h.solWallet)}</span>
          {h.linkPendingUntil && <> (active from <span className="num">{formatDate(h.linkPendingUntil)}</span>)</>}. Linking a different wallet replaces it after a 48-hour wait.
        </p>
      )}
    </div>
  );
};
