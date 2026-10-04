import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { RefundHolderDto, RefundPayoutDto, RefundSummaryDto } from "@pyre/shared";
import { PYRE_SOL_DEV_LOCK_URL, REFUND_SNAPSHOT, VENUES } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { env } from "../../env.js";
import { SOL, formatBps, formatDate, formatEth, formatNative, formatTokenUnits, formatUsd, timeAgo } from "../../lib/format.js";
import { ROBINHOOD, EVM_ADDRESS, useVenueLinks } from "../../lib/venue.js";
import { Address, Button, Card, CardHeader, Chip, Field, Input, Progress, Skeleton, Table, type ChipTone, type Column } from "../../ui/index.js";
import { HOLDING_CHIP, HOLD_RULE, fraction, holdingOf } from "./holding.js";
import { useRefundHolder, useRefundSummary } from "./hooks.js";
import { LinkFlow } from "./LinkFlow.js";

const ANNOUNCEMENT_URL = "https://x.com/PyreFun/status/2106687742541287487";

/** "2026-10-04 09:12:28 UTC" from the snapshot's ISO time. */
const SNAPSHOT_TIME = `${REFUND_SNAPSHOT.blockTime.replace("T", " ").replace("Z", "")} UTC`;

export const RefundPage = () => {
  const summary = useRefundSummary();
  const [params, setParams] = useSearchParams();
  const lookup = params.get("address");
  useEffect(() => {
    document.title = "PYRE refunds — Pyre";
  }, []);

  const showHolder = (address: string) => setParams({ address }, { replace: true });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10">
      <Hero summary={summary.data} />
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <WhatsHappening />
        <HowItWorks />
      </section>
      <Totals summary={summary.data} pending={summary.isPending} failed={summary.isError} />
      <Lookup address={lookup} onLookup={showHolder} />
      <LinkFlow live={summary.data?.live ?? false} onLinked={showHolder} />
    </div>
  );
};

const Hero = ({ summary }: { summary: RefundSummaryDto | undefined }) => {
  const solana = useVenueLinks(VENUES.pump_fun);
  const mint = summary?.mint ?? null;
  return (
    <header className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <div className="flex min-w-0 flex-col gap-5">
        <h1 className="display text-48 sm:text-64">
          <em>PYRE</em> refunds
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {summary === undefined ? (
            <Skeleton className="h-5 w-40" rounded="pill" />
          ) : summary.live ? (
            <Chip size="sm" mono tone="earn" dot>
              Payouts live
            </Chip>
          ) : (
            <Chip size="sm" mono tone="warn" dot>
              Payouts start when the Solana coin is live
            </Chip>
          )}
        </div>
        <p className="body max-w-2xl text-ink-2">
          PYRE is moving to Solana as a fair launch on pump.fun. Everyone who held PYRE on Robinhood Chain at the snapshot and still holds it is refunded the ETH they put in,
          paid in SOL from a share of the new coin's creator fees, until every holder is paid back.
        </p>
        <p className="small max-w-2xl text-ink-3">
          A refund returns the ETH you put in minus the ETH you took out, capped at what you paid for the PYRE you still held at the snapshot, and never more than that. Selling or moving PYRE after the snapshot shrinks it for
          good. It is not a return on holding, and holding PYRE now earns nothing from it.
        </p>
      </div>
      <Card tone="inset">
        <CardHeader eyebrow="Snapshot" title={<span className="num">block {REFUND_SNAPSHOT.block.toLocaleString("en-US")}</span>} description="Fixed before the move was announced." />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-13">
          <dt className="eyebrow">Time</dt>
          <dd className="num text-ink">{SNAPSHOT_TIME}</dd>
          <dt className="eyebrow">Block</dt>
          <dd className="min-w-0">
            <a href={`${env.explorerUrl}/block/${REFUND_SNAPSHOT.block}`} target="_blank" rel="noreferrer noopener" className="num text-ink underline-offset-2 hover:text-accent hover:underline">
              {REFUND_SNAPSHOT.block} ↗
            </a>
          </dd>
          <dt className="eyebrow">Hash</dt>
          <dd className="min-w-0">
            <Address address={REFUND_SNAPSHOT.blockHash} kind="tx" chars={6} explorerUrl={null} className="text-13" />
          </dd>
          <dt className="eyebrow">Coin</dt>
          <dd className="min-w-0">
            <Address address={REFUND_SNAPSHOT.token} chars={4} explorerUrl={ROBINHOOD.token(REFUND_SNAPSHOT.token)} className="text-13" />
          </dd>
          <dt className="eyebrow">Solana</dt>
          <dd className="min-w-0">
            {mint ? (
              <Address address={mint} chars={4} identicon={false} explorerUrl={solana.token(mint)} className="text-13" />
            ) : (
              <span className="num text-ink-3">not launched yet</span>
            )}
          </dd>
        </dl>
        <p className="small mt-4 text-ink-3">
          {mint ? "This is the only Solana PYRE mint that is ours." : "Until the Solana coin launches, only the mint published here and on pyre.fun is ours. Any PYRE on Solana before then is not."}
        </p>
      </Card>
    </header>
  );
};

const WhatsHappening = () => (
  <Card>
    <CardHeader eyebrow="What's happening" title="PYRE moves to Solana" />
    <div className="flex flex-col gap-3 text-14 text-ink-2">
      <p>
        PYRE relaunches as a new coin on pump.fun. It is a fair launch: no pre-sale, no allocation, no whitelist. The founder makes a 2 SOL dev buy in the creation transaction, on the
        same curve, and{" "}
        <a href={PYRE_SOL_DEV_LOCK_URL} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
          locks those tokens on Streamflow until 2027-10-04
        </a>
        , with no way to cancel or transfer the lock. 100% of the coin's creator fees go to the Pyre treasury's Solana wallet through pump.fun fee sharing, a split pump.fun makes final.
      </p>
      <p>
        Who is owed was fixed at Robinhood Chain block <span className="num text-ink">{REFUND_SNAPSHOT.block}</span>, at <span className="num text-ink">{SNAPSHOT_TIME}</span> — before
        the{" "}
        <a href={ANNOUNCEMENT_URL} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
          announcement
        </a>
        . Only addresses holding PYRE at that block are eligible, and only while they keep holding it. PYRE bought after it doesn't count.
      </p>
      <p>Robinhood Chain PYRE stays where it is; nothing about it changes on-chain.</p>
    </div>
  </Card>
);

const HowItWorks = () => (
  <Card>
    <CardHeader eyebrow="How refunds work" title="ETH in, paid back in SOL" />
    <ol className="flex flex-col gap-3 text-14 text-ink-2">
      <Step n="01">
        <span className="text-ink">Owed = the ETH you put in minus the ETH you took out, capped at what you paid for the PYRE you still held at the snapshot</span>, from launch up
        to the snapshot block, counted for the wallet that sent each trade. Sold most and kept dust? You are owed the cost of the dust. PYRE that only arrived by transfer earns
        nothing. Never below zero.
      </Step>
      <Step n="02">
        <span className="text-ink">To be refunded, {HOLD_RULE}</span> Moving it to another wallet you own counts as moving. Your refund is scaled by the lowest balance you have
        held since the snapshot: drop to half and you are refunded half of what you were owed.
      </Step>
      <Step n="03">
        <span className="num text-ink">25%</span> of the Solana PYRE coin's creator fees goes to the refund pool each time they are claimed. The other 75% stays with the treasury.
      </Step>
      <Step n="04">
        The pool is split pro-rata to what each holder is still owed and paid in SOL to the Solana wallet they linked. Owed is counted in ETH, so each share is converted at the ETH
        price of the moment and never pays anyone past what they put in.
      </Step>
      <Step n="05">
        It keeps going until everyone is paid back. If you haven't linked yet, your share waits for you as credit. Credit already allocated stays yours even if you sell later.
      </Step>
    </ol>
  </Card>
);

const Step = ({ n, children }: { n: string; children: ReactNode }) => (
  <li className="flex gap-3">
    <span className="num shrink-0 text-ink-3">{n}</span>
    <span>{children}</span>
  </li>
);

const Totals = ({ summary, pending, failed }: { summary: RefundSummaryDto | undefined; pending: boolean; failed: boolean }) => {
  if (failed) return <p className="text-danger">Refund totals could not be loaded.</p>;
  if (pending || !summary) return <Skeleton className="h-48" rounded="card" />;
  const settled = fraction(summary.totalSettledWei, summary.totalEligibleWei);
  return (
    <Card>
      <CardHeader
        eyebrow="Program totals"
        title="Paid back so far"
        description={summary.live ? "Live from the refund ledger." : "Payouts start once the Solana coin is live. Until then nothing accrues."}
      />
      <Progress value={settled} tone="earn" size="md" label="Share of eligible ETH settled" />
      <p className="num mt-2 text-13 text-ink-2">
        <span className="text-earn">{formatEth(summary.totalSettledWei)}</span> of {formatEth(summary.totalEligibleWei)} eligible settled · {(settled * 100).toFixed(2)}%
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-5">
        <Stat label="Holders at snapshot">{summary.holders.toLocaleString("en-US")}</Stat>
        <Stat label="Still holding">
          {summary.stillHoldingHolders.toLocaleString("en-US")}
          <span className="small block text-ink-3">of {summary.holders.toLocaleString("en-US")} at snapshot</span>
        </Stat>
        <Stat label="Owed a refund">{summary.owedHolders.toLocaleString("en-US")}</Stat>
        <Stat label="Wallets linked">
          {summary.linkedHolders.toLocaleString("en-US")}
          <span className="small block text-ink-3">of {summary.owedHolders.toLocaleString("en-US")} owed</span>
        </Stat>
        <Stat label="Fee share">{formatBps(summary.feeBps)}</Stat>
        <Stat label="Owed at snapshot">{formatEth(summary.totalOwedWei)}</Stat>
        <Stat label="Eligible now">{formatEth(summary.totalEligibleWei)}</Stat>
        <Stat label="Settled">
          <span className="text-earn">{formatEth(summary.totalSettledWei)}</span>
        </Stat>
        <Stat label="Paid in SOL">{formatUsd(summary.totalPaidMicros)}</Stat>
        <Stat label="In the pool">{formatUsd(summary.poolMicros)}</Stat>
      </dl>
      <p className="small mt-4 text-ink-3">
        USD at the time of each allocation and payout. Eligible is what is owed after cuts for PYRE sold or moved since the snapshot. Settled is the ETH-equivalent allocated to
        holders; paid is what has been sent.
      </p>
    </Card>
  );
};

const Stat = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0">
    <dt className="eyebrow">{label}</dt>
    <dd className="num truncate text-18 text-ink sm:text-22">{children}</dd>
  </div>
);

const Lookup = ({ address, onLookup }: { address: string | null; onLookup: (address: string) => void }) => {
  const [input, setInput] = useState(address ?? "");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setInput(address ?? ""), [address]);
  const valid = address !== null && EVM_ADDRESS.test(address);
  const holder = useRefundHolder(valid ? address : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = input.trim();
    if (!EVM_ADDRESS.test(a)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onLookup(a);
  };

  return (
    <Card padding={0} id="lookup">
      <div className="p-4 sm:p-5">
        <CardHeader eyebrow="Look up" title="What is owed to an address" description="Any Robinhood Chain address. Nothing to sign." />
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <Field label="Robinhood Chain address" error={invalid ? "Enter a 0x address: 0x followed by 40 hex characters." : undefined} className="min-w-0 flex-1">
            <Input
              mono
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              invalid={invalid}
            />
          </Field>
          <Button type="submit" variant="secondary" className="sm:mt-[26px]" loading={holder.isFetching && holder.isPending}>
            Look up
          </Button>
        </form>
      </div>
      {valid && <HolderResult query={holder} />}
      {address !== null && !valid && (
        <p className="small px-4 pb-4 text-danger sm:px-5 sm:pb-5" role="alert">
          {address} is not a Robinhood Chain address.
        </p>
      )}
    </Card>
  );
};

const HolderResult = ({ query }: { query: UseQueryResult<RefundHolderDto> }) => {
  if (query.isPending) return <Skeleton className="mx-4 mb-4 h-40 sm:mx-5 sm:mb-5" rounded="card" />;
  if (query.isError) {
    const e = query.error;
    const msg =
      isHttpError(e) && e.error === "not_eligible"
        ? `Not on the snapshot: this address held no PYRE at block ${REFUND_SNAPSHOT.block}, so nothing is owed to it.`
        : isHttpError(e) && e.error === "bad_address"
          ? "That is not a valid Robinhood Chain address."
          : isHttpError(e) && e.status === 429
            ? "Too many lookups. Try again in a minute."
            : "The lookup failed. Try again.";
    return (
      <p className="small border-t border-line px-4 py-4 text-danger sm:px-5" role="alert">
        {msg}
      </p>
    );
  }
  return <HolderView holder={query.data} />;
};

/** Payout progress; `null` when the holding status already says everything (nothing owed, or sold out). */
const payoutStatus = (h: RefundHolderDto): { tone: ChipTone; label: string } | null => {
  if (BigInt(h.owedWei) === 0n) return { tone: "neutral", label: "Nothing owed" };
  if (BigInt(h.eligibleWei) === 0n) return null;
  if (BigInt(h.remainingWei) === 0n) return { tone: "earn", label: "Paid back in full" };
  if (!h.solWallet) return { tone: "warn", label: "Owed · not linked" };
  return { tone: "accent", label: "Owed · linked" };
};

const fmtPyre = (units: string) => formatTokenUnits(units, { compact: false, digits: 2 });

const HolderView = ({ holder }: { holder: RefundHolderDto }) => {
  const solana = useVenueLinks(VENUES.pump_fun);
  const owed = BigInt(holder.owedWei);
  const bought = BigInt(holder.boughtUnits);
  const loss = BigInt(holder.ethInWei) - BigInt(holder.ethOutWei);
  // Owed is capped at the cost of the PYRE still held when that is below the net loss.
  const capped = bought > 0n && owed > 0n && owed < loss;
  const eligible = BigInt(holder.eligibleWei);
  const holding = holdingOf(holder);
  const holdingChip = HOLDING_CHIP[holding];
  const status = payoutStatus(holder);
  const kept = fraction(holder.minBalanceUnits, holder.balanceUnits);
  const settled = fraction(holder.settledWei, holder.eligibleWei);
  const creditLeft = BigInt(holder.creditMicros) > 0n;
  return (
    <div className="border-t border-line">
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Address address={holder.address} chars={6} explorerUrl={ROBINHOOD.address(holder.address)} className="text-14" />
          <Chip size="sm" mono tone={holdingChip.tone} dot>
            {holdingChip.label}
          </Chip>
          {status && (
            <Chip size="sm" mono tone={status.tone}>
              {status.label}
            </Chip>
          )}
        </div>
        {owed === 0n ? (
          <p className="small text-ink-2">
            {bought === 0n
              ? "This address never bought PYRE itself before the snapshot (what it held arrived by transfer), so it is not owed a refund."
              : "This address got back at least as much ETH selling PYRE as it spent buying it before the snapshot, so it is not owed a refund."}
          </p>
        ) : holding === "soldOut" ? (
          <p className="small text-ink-2">
            This address sold or moved all the PYRE it held at the snapshot, so it is no longer eligible: its refund dropped from {formatEth(holder.owedWei)} to nothing. Buying
            PYRE again doesn't restore it.
            {creditLeft && holder.solWallet && " Credit allocated before it sold is still paid to the linked wallet."}
          </p>
        ) : holding === "reduced" ? (
          <p className="small text-ink-2">
            This address went down to <span className="num text-ink">{fmtPyre(holder.minBalanceUnits)}</span> PYRE after the snapshot,{" "}
            <span className="num text-ink">{(kept * 100).toFixed(2)}%</span> of what it held, so its refund is cut to <span className="num text-ink">{formatEth(holder.eligibleWei)}</span>{" "}
            of the {formatEth(holder.owedWei)} it was owed. Buying more doesn't raise it; selling more lowers it further.
          </p>
        ) : (
          <p className="small text-ink-2">This address still holds all the PYRE it had at the snapshot, so its full refund stands. Selling or moving any of it would shrink it for good.</p>
        )}
        {eligible > 0n && (
          <div>
            <Progress value={settled} tone="earn" size="sm" label="Share of this refund settled" />
            <p className="num mt-1.5 text-12 text-ink-3">{(settled * 100).toFixed(2)}% settled</p>
          </div>
        )}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="PYRE at snapshot">{fmtPyre(holder.balanceUnits)}</Stat>
          <Stat label="PYRE now">{fmtPyre(holder.currentBalanceUnits)}</Stat>
          <Stat label="Lowest since snapshot">{fmtPyre(holder.minBalanceUnits)}</Stat>
          <Stat label="Refund kept">
            <span className={holding === "holding" ? undefined : holding === "reduced" ? "text-warn" : "text-ink-3"}>{(kept * 100).toFixed(2)}%</span>
          </Stat>
        </dl>
        <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
          <Stat label="ETH in">{formatEth(holder.ethInWei)}</Stat>
          <Stat label="ETH out">{formatEth(holder.ethOutWei)}</Stat>
          <Stat label="PYRE bought">{fmtPyre(holder.boughtUnits)}</Stat>
          <Stat label="Owed at snapshot">{formatEth(holder.owedWei)}</Stat>
          <Stat label="Eligible">{formatEth(holder.eligibleWei)}</Stat>
          <Stat label="Settled">
            <span className="text-earn">{formatEth(holder.settledWei)}</span>
          </Stat>
          <Stat label="Remaining">{formatEth(holder.remainingWei)}</Stat>
          <Stat label="Credit waiting">{formatUsd(holder.creditMicros)}</Stat>
          <Stat label="Paid">{formatUsd(holder.paidMicros)}</Stat>
        </dl>
        {capped && (
          <p className="small text-ink-3">
            Owed is capped: this address put in {formatEth(holder.ethInWei)} and took out {formatEth(holder.ethOutWei)}, but it still held only{" "}
            <span className="num text-ink">{fmtPyre(holder.balanceUnits)}</span> of the <span className="num text-ink">{fmtPyre(holder.boughtUnits)}</span> PYRE it bought, so
            it is owed what that PYRE cost, {formatEth(holder.owedWei)}, not {formatEth(loss.toString())}.
          </p>
        )}
        <div className="flex flex-col gap-1 border-t border-line pt-3 text-13">
          <span className="eyebrow">Payout wallet</span>
          {holder.solWallet ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Address address={holder.solWallet} chars={6} identicon={false} explorerUrl={solana.address(holder.solWallet)} className="text-13" />
              {holder.linkedAt && <span className="num text-12 text-ink-3">linked {timeAgo(holder.linkedAt)}</span>}
              {holder.linkPendingUntil && (
                <span className="text-12 text-warn">
                  New payout wallet active from <span className="num">{formatDate(holder.linkPendingUntil)}</span>. A changed wallet waits 48 hours before it is paid; if you did not change it, link your own wallet again.
                </span>
              )}
            </span>
          ) : eligible > 0n ? (
            <span className="text-ink-2">
              Not linked.{" "}
              <a href="#link" className="text-accent underline underline-offset-2">
                Link a Solana wallet
              </a>{" "}
              to receive it; credit waits until you do.
            </span>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </div>
      </div>
      {holder.payouts.length > 0 && <Payouts payouts={holder.payouts} />}
    </div>
  );
};

const PAYOUT_TONE: Record<RefundPayoutDto["status"], ChipTone> = { PENDING: "warn", SENT: "accent", CONFIRMED: "earn", FAILED: "neutral" };

const Payouts = ({ payouts }: { payouts: RefundPayoutDto[] }) => {
  const solana = useVenueLinks(VENUES.pump_fun);
  const columns: Column<RefundPayoutDto>[] = [
    { key: "when", header: "When", render: (p) => <span className="text-ink-2">{timeAgo(p.createdAt)}</span> },
    { key: "usd", header: "USD", numeric: true, render: (p) => formatUsd(p.usdMicros) },
    { key: "sol", header: "SOL", numeric: true, render: (p) => formatNative(p.lamports, SOL, { unit: false }) },
    {
      key: "status",
      header: "Status",
      render: (p) => (
        <Chip size="sm" mono tone={PAYOUT_TONE[p.status]}>
          {p.status.toLowerCase()}
        </Chip>
      ),
    },
    {
      key: "tx",
      header: "Tx",
      render: (p) => (p.txSig ? <Address address={p.txSig} kind="tx" chars={4} explorerUrl={solana.tx(p.txSig)} copy={false} /> : <span className="text-ink-3">—</span>),
    },
    { key: "to", header: "To", collapse: true, render: (p) => <Address address={p.solWallet} chars={4} identicon={false} explorerUrl={solana.address(p.solWallet)} copy={false} /> },
  ];
  return (
    <div className="border-t border-line">
      <div className="eyebrow px-4 pt-4 sm:px-5">Payout history</div>
      <Table columns={columns} rows={payouts} rowKey={(p) => p.id} caption="Refund payouts" />
    </div>
  );
};
