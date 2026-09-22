import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PyreBurnDto, PyrePageDto } from "@pyre/shared";
import { LAUNCH_PHASE, explorerTxUrl } from "@pyre/shared";
import { env } from "../../env.js";
import { formatBps, formatEth, formatTokenUnits, formatUsd, timeAgo } from "../../lib/format.js";
import { Address, Button, Card, CardHeader, Chip, EmptyState, GraduationRing, NumberFlow, Progress, Skeleton, Table, UsdFlow, type Column } from "../../ui/index.js";
import { usePyre } from "./hooks.js";
import { MyStakes, StakeForm, TopStakes } from "./Staking.js";


export const PyrePage = () => {
  const q = usePyre();
  useEffect(() => {
    document.title = "$PYRE — Pyre";
  }, []);

  if (q.isPending) {
    // Viewport-tall so the footer never paints in view and jumps away when the page lands; the top mirrors the header grid.
    return (
      <div className="mx-auto min-h-dvh w-full max-w-6xl space-y-10" aria-busy>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <div className="space-y-5">
            <Skeleton className="h-16 w-56" />
            <Skeleton className="h-6 w-32" rounded="pill" />
            <Skeleton lines={4} />
            <Skeleton className="h-24 w-full max-w-md" />
          </div>
          <Skeleton className="h-44" rounded="card" />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" rounded="card" />
          <Skeleton className="h-64" rounded="card" />
        </div>
      </div>
    );
  }
  if (q.isError || !q.data) return <p className="text-danger">$PYRE could not be loaded.</p>;

  const page = q.data;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10">
      {page.token ? <Header page={page} token={page.token} /> : <PreLaunch page={page} />}
      <OneChain />
      <Accrual page={page} />
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <StakeForm page={page} />
        <TopStakes page={page} />
      </section>
      {page.viewer && <MyStakes page={page} />}
      <Burns burns={page.burns} />
    </div>
  );
};

const Header = ({ page, token }: { page: PyrePageDto; token: NonNullable<PyrePageDto["token"]> }) => {
  const graduated = token.phase === LAUNCH_PHASE.POOL;
  return (
    <header className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <GraduationRing progress={token.progress} graduated={graduated} size={56}>
            <span className="grid h-full w-full place-items-center rounded-pill bg-raised text-12 font-semibold text-ink">P</span>
          </GraduationRing>
          <div>
            <h1 className="display text-48 sm:text-64">
              <em>$PYRE</em>
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Chip size="sm" mono tone={graduated ? "earn" : "accent"}>
                {graduated ? "Uniswap v4 pool" : `PONS curve · ${Math.round(token.progress * 100)}% to 4.2 ETH`}
              </Chip>
              <Address address={token.address} chars={6} explorerUrl={token.explorerUrl} className="text-13" />
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Price">
            <NumberFlow value={token.priceUsd} format={{ style: "currency", currency: "USD", maximumFractionDigits: token.priceUsd < 0.01 ? 8 : 4 }} />
            <span className="small block text-ink-3">{token.priceEth.toPrecision(3)} ETH</span>
          </Stat>
          <Stat label="Market cap">
            <UsdFlow micros={BigInt(Math.round(token.mcapUsd * 1e6))} compact />
          </Stat>
          <Stat label="Burned">
            <span className="text-burn">
              <NumberFlow value={token.burnedPct} format={{ maximumFractionDigits: 3 }} suffix="%" />
            </span>
            <span className="small block text-ink-3">{formatTokenUnits(token.burnedUnits, { compact: true })} of {formatTokenUnits(token.totalSupplyUnits, { compact: true })}</span>
          </Stat>
          <Stat label="Burned in ETH">
            <span className="text-burn">{formatEth(page.burns.reduce((s, b) => s + BigInt(b.ethWei), 0n))}</span>
            <span className="small block text-ink-3">{page.burns.length} burns</span>
          </Stat>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button href={token.ponsUrl} target="_blank" rel="noreferrer noopener">
            Trade on PONS ↗
          </Button>
          <Button variant="ghost" href={token.explorerUrl} target="_blank" rel="noreferrer noopener">
            Blockscout ↗
          </Button>
        </div>
      </div>
      <Card>
        <CardHeader eyebrow="Supply" title="1,000,000,000 minted" description="Every burn lowers totalSupply for good." />
        <Progress value={token.burnedPct / 100} tone="heat" size="md" label="Share of supply burned" />
        <p className="num mt-2 text-13 text-ink-2">
          <span className="text-burn">{formatTokenUnits(token.burnedUnits, { compact: true })}</span> burned · {formatTokenUnits(BigInt(token.totalSupplyUnits) - BigInt(token.burnedUnits), { compact: true })} remain
        </p>
      </Card>
    </header>
  );
};

const PreLaunch = ({ page }: { page: PyrePageDto }) => (
  <header className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
    <div className="flex flex-col gap-5">
      <h1 className="display text-48 sm:text-64">
        <em>$PYRE</em>
      </h1>
      <Chip size="sm" mono tone="warn" dot>
        Not launched yet
      </Chip>
      <p className="body max-w-2xl text-ink-2">
        $PYRE is the platform's own coin: a PONS v2 launch made from the treasury wallet, on the same curve and under the same rules as every coin on Pyre. It does not exist
        on-chain yet, so there is no price, no market cap and no burn to show. What already exists is the ledger below — the share of every coin's creator fees that is
        earmarked for buying and burning it the moment it launches.
      </p>
      <dl className="grid max-w-md grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 border-y border-line py-3 text-13">
        <dt className="eyebrow">Contract</dt>
        <dd className="num text-ink-3">not launched yet</dd>
        <dt className="eyebrow">Chain</dt>
        <dd className="num text-ink">
          {env.chainName} · {env.chainId}
        </dd>
        <dt className="eyebrow">Venue</dt>
        <dd className="num text-ink">PONS v2 curve, then Uniswap v4</dd>
      </dl>
      <p className="small text-ink-3">No pre-sale, no allocation, no whitelist. When it launches, the address appears here and on the feed. It launches on Robinhood Chain and nowhere else.</p>
    </div>
    <Card tone="inset">
      <CardHeader eyebrow="Earmarked so far" title={formatUsd(BigInt(page.ledger.pendingMicros))} description="Accrued to the PYRE_TOKEN ledger account, waiting for a token to buy." />
      <dl className="grid grid-cols-1 gap-3 text-13">
        <div>
          <dt className="eyebrow">From fees</dt>
          <dd className="num text-ink">{formatBps(page.feeShareBps)} of every coin's fee claims</dd>
        </div>
      </dl>
    </Card>
  </header>
);

/** The one thing a reader must not get wrong: there is exactly one PYRE, on exactly one chain. */
const OneChain = () => (
  <section
    aria-label="PYRE is single-chain"
    className="rounded-card border border-[color-mix(in_oklab,var(--color-warn)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-warn)_6%,transparent)] px-4 py-3 text-14"
  >
    <div className="eyebrow mb-1 text-warn">One coin, one chain</div>
    <p className="text-ink">PYRE lives on Robinhood Chain only — any PYRE on another chain is not ours.</p>
    <p className="small mt-1 text-ink-2">
      Coins launched on Solana still route 25% of their fees to a buy-and-burn, but it buys and burns the coin itself, never a bridged or wrapped PYRE. There is no PYRE on Solana, no
      bridge, and no plan for one.
    </p>
  </section>
);

const Accrual = ({ page }: { page: PyrePageDto }) => (
  <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <Card>
      <CardHeader eyebrow="How $PYRE accrues" title="Bought and burned, never distributed" />
      <ol className="flex flex-col gap-3 text-14 text-ink-2">
        <li className="flex gap-3">
          <span className="num shrink-0 text-ink-3">01</span>
          <span>
            <span className="num text-ink">{formatBps(page.feeShareBps)}</span> of every coin's claimed creator fees is credited to the <span className="num">PYRE_TOKEN</span> ledger account.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="num shrink-0 text-ink-3">02</span>
          <span>
            Every 10 minutes, when the balance clears $5, the treasury buys $PYRE on the curve or in the pool and calls <span className="num">burn()</span>. Supply falls. Each burn is attested on-chain.
          </span>
        </li>
      </ol>
      <p className="small mt-4 text-ink-3">Nothing is ever sent to holders. Holding $PYRE gets you governance weight — {page.proposals.open} open proposals, {page.proposals.shipped} shipped — and the right to stake it to an app.{" "}
        <Link to="/governance" className="text-accent underline underline-offset-2">Governance</Link>
      </p>
    </Card>
    <Card tone="inset">
      <CardHeader eyebrow="PYRE_TOKEN ledger" title="Accrued vs burned" />
      <dl className="grid grid-cols-3 gap-4">
        <div>
          <dt className="eyebrow">Accrued</dt>
          <dd className="num text-18 text-ink">{formatUsd(BigInt(page.ledger.accruedMicros), 0)}</dd>
        </div>
        <div>
          <dt className="eyebrow">Burned</dt>
          <dd className="num text-18 text-burn">{formatUsd(BigInt(page.ledger.burnedMicros), 0)}</dd>
        </div>
        <div>
          <dt className="eyebrow">Pending</dt>
          <dd className="num text-18 text-ink-2">{formatUsd(BigInt(page.ledger.pendingMicros), 0)}</dd>
        </div>
      </dl>
      <p className="small mt-4 text-ink-3">USD at the time each fee claim was recorded. Burns below are the on-chain record; the ledger is the accounting.</p>
    </Card>
  </section>
);

const Burns = ({ burns }: { burns: PyreBurnDto[] }) => {
  const columns: Column<PyreBurnDto>[] = [
    { key: "when", header: "When", render: (b) => <span className="text-ink-2">{timeAgo(b.createdAt)}</span> },
    { key: "eth", header: "ETH spent", numeric: true, render: (b) => formatEth(b.ethWei) },
    { key: "burned", header: "Burned", numeric: true, render: (b) => <span className="text-burn">{formatTokenUnits(b.burnedUnits, { compact: true })}</span> },
    { key: "pct", header: "% supply", numeric: true, collapse: true, render: (b) => `${b.burnedPctOfSupply.toFixed(4)}%` },
    { key: "src", header: "Ledger", numeric: true, collapse: true, render: (b) => formatUsd(BigInt(b.usdMicros)) },
    {
      key: "tx",
      header: "Burn tx",
      render: (b) => (b.burnTx ? <Address address={b.burnTx} kind="tx" chars={4} explorerUrl={explorerTxUrl(b.burnTx)} copy={false} /> : <span className="text-ink-3">pending</span>),
    },
    {
      key: "attest",
      header: "Attest",
      collapse: true,
      render: (b) => (b.attestTx ? <Address address={b.attestTx} kind="tx" chars={4} explorerUrl={explorerTxUrl(b.attestTx)} copy={false} /> : <span className="text-ink-3">—</span>),
    },
  ];
  return (
    <Card padding={0}>
      <CardHeader className="px-4 pt-4 sm:px-5 sm:pt-5" eyebrow="Burn history" title="$PYRE burns" description="Newest first. Every row is a swap, a burn and an attestation on Robinhood Chain." />
      {burns.length === 0 ? (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <EmptyState title="No burns yet" body="The first burn happens once the token exists and the ledger clears $5." />
        </div>
      ) : (
        <Table columns={columns} rows={burns} rowKey={(b) => b.id} caption="$PYRE burn history" />
      )}
    </Card>
  );
};

const Stat = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <dt className="eyebrow">{label}</dt>
    <dd className="num text-22 text-ink">{children}</dd>
  </div>
);

