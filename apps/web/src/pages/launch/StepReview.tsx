import { Suspense, lazy, useState, type ReactNode } from "react";
import type { AppSpec, LaunchDraftDto, MeDto, StakeBody } from "@pyre/shared";
import { FEE_SPLIT_BPS, PONS_GRADUATION_THRESHOLD_WEI, REVENUE_SPLIT_BPS, explorerAddressUrl } from "@pyre/shared";
import { useAuth } from "../../auth/useAuth.js";
import { formatBps, formatEth } from "../../lib/format.js";
import { Address, Button, Chip, Tabs } from "../../ui/index.js";
import { DepositTray } from "../me/DepositTray.js";

// Dynamic on purpose: the external stake is the only path here that needs `lib/wallet.ts`, and a
// static import would put viem's wallet stack (the `wallet-*` chunk) in /launch's initial graph.
const ExternalStake = lazy(async () => ({ default: (await import("./ExternalStake.js")).ExternalStake }));

type Method = "custodial" | "external";

interface Props {
  launch: LaunchDraftDto;
  spec: AppSpec;
  me: MeDto | null;
  busy: boolean;
  error: string | null;
  onStake: (body: StakeBody) => void;
  onBack: () => void;
}

export const StepReview = ({ launch, spec, me, busy, error, onStake, onBack }: Props) => {
  const auth = useAuth();
  const [method, setMethod] = useState<Method>(auth.externalWallet ? "external" : "custodial");
  const [deposit, setDeposit] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const need = BigInt(launch.requiredStakeWei);
  const have = BigInt(me?.balances.ethWei ?? "0");
  const short = have < need;

  return (
    <div className="flex flex-col gap-7">
      <Summary launch={launch} spec={spec} />

      <section className="flex flex-col gap-3">
        <h3 className="eyebrow">How the money moves</h3>
        <ol className="grid gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-2">
          <Fact n="01" title="PONS v2 curve">
            <span className="num text-ink">${launch.ticker}</span> launches on a PONS v2 bonding curve. Trades pay a <span className="num text-ink">1%</span> fee;{" "}
            <span className="num text-ink">70%</span> of it goes to the creator wallet — which is the app's own wallet, not yours.
          </Fact>
          <Fact n="02" title="Graduation at 4.2 ETH">
            When the curve raises <span className="num text-ink">{formatEth(PONS_GRADUATION_THRESHOLD_WEI, { digits: 1 })}</span> it closes and liquidity moves to a Uniswap v4 pool. Same 1% fee, same 70% to the app.
          </Fact>
          <Fact n="03" title="Fees fund the agent">
            Every claimed fee splits <span className="num text-ink">{formatBps(FEE_SPLIT_BPS.BUILD_BUDGET)}</span> build budget ·{" "}
            <span className="num text-ink">{formatBps(FEE_SPLIT_BPS.PYRE_TOKEN)}</span> $PYRE burn · <span className="num text-ink">{formatBps(FEE_SPLIT_BPS.LAUNCHER)}</span> to you. The agent
            starts building at $50 of budget.
          </Fact>
          <Fact n="04" title="Revenue burns the coin">
            App revenue splits <span className="num text-ink">{formatBps(REVENUE_SPLIT_BPS.BUYBACK_BURN)}</span> buyback + burn of ${launch.ticker} ·{" "}
            <span className="num text-ink">{formatBps(REVENUE_SPLIT_BPS.PYRE_TOKEN)}</span> $PYRE · <span className="num text-ink">{formatBps(REVENUE_SPLIT_BPS.PLATFORM_OPS)}</span> ops. Burns
            reduce supply; nothing is paid to holders.
          </Fact>
        </ol>
      </section>

      <section className="rounded-card border border-[color-mix(in_oklab,var(--color-warn)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-warn)_6%,transparent)] px-4 py-3">
        <div className="eyebrow mb-2 text-warn">Cannot be changed after creation</div>
        <ul className="grid gap-1 text-14 text-ink-2 sm:grid-cols-2">
          <li>Name, ticker and image — written to the chain by PONS.</li>
          <li>The creator wallet — the app's, forever.</li>
          <li>Supply: 1,000,000,000, all minted to the curve. No allocation to you or to Pyre.</li>
          <li>The fee split above. The brief can still evolve through the build queue.</li>
        </ul>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="eyebrow">Stake {formatEth(need)}</h3>
          <span className="small text-ink-3">Refundable · spam control only</span>
        </div>
        <p className="text-14 text-ink-2">
          The stake goes to the platform treasury and comes back to your wallet when the app reaches its first build threshold, or immediately if the launch fails. The platform pays the
          PONS launch fee and gas itself.
        </p>
        <Tabs
          name="stake-method"
          variant="pill"
          size="sm"
          value={method}
          onChange={setMethod}
          items={[
            { id: "custodial", label: "Pyre balance" },
            { id: "external", label: "External wallet" },
          ]}
        />
        {method === "custodial" ? (
          <div className="flex flex-col gap-3 rounded-card border border-line p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-14 text-ink-2">Your Pyre balance</span>
              <span className={`num text-15 ${short ? "text-warn" : "text-ink"}`}>{formatEth(have)}</span>
            </div>
            {me && <Address address={me.wallet} chars={6} explorerUrl={explorerAddressUrl(me.wallet)} className="text-13" />}
            {short ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="small text-ink-3">Short by {formatEth(need - have)}. Deposit ETH on Robinhood Chain, then come back — the balance refreshes on its own.</span>
                <Button variant="secondary" onClick={() => setDeposit(true)}>
                  Deposit ETH
                </Button>
              </div>
            ) : (
              <p className="small text-ink-3">One click. {formatEth(need)} is debited from this balance and the launch starts right away.</p>
            )}
          </div>
        ) : (
          <Suspense fallback={<span className="small text-ink-3">Looking for wallets…</span>}>
            <ExternalStake to={launch.stakeTo} wei={need} busy={busy} onSent={(txHash) => onStake({ txHash })} />
          </Suspense>
        )}
      </section>

      {error && (
        <p role="alert" className="text-13 text-danger">
          {error}
        </p>
      )}

      <label className="flex items-start gap-3 text-14 text-ink-2">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1 h-4 w-4 accent-(--color-accent)" />
        <span>
          I have read the <a href="/legal/terms" target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">terms</a>. Buybacks are burns, not payouts; the coin is a
          third-party asset on PONS; I can lose everything I spend on it.
        </span>
      </label>

      <div className="flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back to brief
        </Button>
        {method === "custodial" && (
          <Button size="lg" loading={busy} disabled={short || !confirmed || !me} onClick={() => onStake({ custodial: true })}>
            Stake {formatEth(need)} &amp; launch
          </Button>
        )}
      </div>

      {me && (
        <DepositTray
          open={deposit}
          onClose={() => setDeposit(false)}
          address={me.wallet}
          short={short ? { needWei: need, haveWei: have, purpose: "The launch stake" } : undefined}
        />
      )}
    </div>
  );
};

const Summary = ({ launch, spec }: { launch: LaunchDraftDto; spec: AppSpec }) => (
  <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
    <div className="flex items-center gap-3">
      <img src={launch.imageUrl} alt="" width={44} height={44} className="rounded-control border border-line object-cover" />
      <div className="min-w-0">
        <div className="truncate text-15 font-medium text-ink">
          {launch.name} <span className="num text-ink-2">${launch.ticker}</span>
        </div>
        <div className="small truncate text-ink-2">{spec.oneLiner}</div>
      </div>
    </div>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-13 sm:grid-cols-4">
      <Row k="Template" v={spec.template.replace("_", " ").toLowerCase()} />
      <Row k="Model" v={spec.monetization.model.replace(/_/g, " ").toLowerCase()} />
      <Row k="Price" v={spec.monetization.priceUsd == null ? "free" : `$${spec.monetization.priceUsd}`} />
      <Row k="MVP" v={`${spec.mvp.length} features`} />
    </dl>
    <div className="flex flex-wrap gap-1.5">
      {spec.mvp.slice(0, 4).map((m) => (
        <Chip key={m} size="sm">
          {m}
        </Chip>
      ))}
      {spec.mvp.length > 4 && <Chip size="sm">+{spec.mvp.length - 4}</Chip>}
    </div>
  </section>
);

const Row = ({ k, v }: { k: string; v: string }) => (
  <div>
    <dt className="eyebrow">{k}</dt>
    <dd className="num truncate text-ink">{v}</dd>
  </div>
);

const Fact = ({ n, title, children }: { n: string; title: string; children: ReactNode }) => (
  <li className="flex flex-col gap-1 bg-surface p-4">
    <div className="flex items-baseline gap-2">
      <span className="num text-12 text-ink-3">{n}</span>
      <span className="text-14 font-medium text-ink">{title}</span>
    </div>
    <p className="small text-ink-2">{children}</p>
  </li>
);

