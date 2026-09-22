import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { BurnLedgerRowDto } from "@pyre/shared";
import { DEAD_ADDRESS } from "@pyre/chain/browser";
import { flatPages, useBurns } from "../../api/queries.js";
import { TxLink } from "../../components/TxLink.js";
import { explorerAddress } from "../../env.js";
import { formatEth, formatPct, formatTokenUnits, formatUsd, timeAgo } from "../../lib/format.js";
import { Button, Card, Chip, EmptyState, EthFlow, Field, Input, NumberFlow, Skeleton, Table, TickFlash, cx, type Column } from "../../ui/index.js";
import { AreaChart, type AreaPoint } from "./AreaChart.js";
import { burnsCsv, downloadText } from "./csv.js";

const dayStart = (s: string): number | null => (s ? new Date(`${s}T00:00:00`).getTime() : null);
const dayEnd = (s: string): number | null => (s ? new Date(`${s}T23:59:59.999`).getTime() : null);

/** Attestation: how anyone can check a burn was paid for by real fee claims. */
const AttestationCell = ({ row }: { row: BurnLedgerRowDto }) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center gap-1.5">
      {row.attestTx ? <TxLink hash={row.attestTx} chars={3} copy={false} /> : <span className="text-ink-3">pending</span>}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cx("num rounded-pill border border-line px-1.5 text-11 leading-4 text-ink-3 transition hover:text-ink", open && "text-ink")}
      >
        ?
      </button>
      {open && (
        <span className="absolute right-0 top-full z-10 mt-1 w-72 whitespace-normal rounded-control border border-line bg-raised p-3 text-12 leading-5 text-ink-2 shadow-lg">
          <span className="block">
            The attest tx is a zero-value self-transfer from the treasury whose calldata is <code className="num">0x5059524501</code> (“PYRE”, v1) followed by{" "}
            <code className="num">sha256</code> of the PYRE_TOKEN ledger-entry ids — one per coin's fee claim — that funded this burn, sorted and comma-joined.
          </span>
          <span className="num mt-1.5 block break-all text-ink-3">{row.attestHash || "hash pending"}</span>
          <span className="mt-1.5 block">Swap and burn txs sit beside it; the burn reduces $PYRE's totalSupply.</span>
        </span>
      )}
    </span>
  );
};

/** `/burns` — every $PYRE buy-and-burn, newest first. */
export const Burns = () => {
  useEffect(() => {
    document.title = "PYRE burns — Pyre";
  }, []);
  const burns = useBurns();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const all = useMemo(() => flatPages(burns.data?.pages), [burns.data]);
  const totals = burns.data?.pages[0]?.totals;

  const rows = useMemo(() => {
    const f = dayStart(from);
    const t = dayEnd(to);
    return all.filter((r) => {
      const ts = new Date(r.createdAt).getTime();
      if (f !== null && ts < f) return false;
      if (t !== null && ts > t) return false;
      return true;
    });
  }, [all, from, to]);

  const filtered = from !== "" || to !== "";
  // Unfiltered: the API's running total per row is exact all-time; a filtered view re-accumulates locally.
  const series = useMemo<AreaPoint[]>(() => {
    const asc = rows.slice().reverse();
    let cum = 0;
    return asc.map((r) => {
      cum += Number(r.ethWei) / 1e18;
      return { t: new Date(r.createdAt).getTime(), v: filtered ? cum : Number(r.cumulativeEthWei) / 1e18 };
    });
  }, [rows, filtered]);
  const viewEth = useMemo(() => (filtered ? rows.reduce((s, r) => s + BigInt(r.ethWei), 0n) : BigInt(totals?.ethWei ?? "0")), [rows, filtered, totals]);
  const last = all[0];

  const columns = useMemo<Column<BurnLedgerRowDto>[]>(
    () => [
      { key: "time", header: "Time", width: 96, render: (r) => <span className="num text-ink-2">{timeAgo(r.createdAt)}</span> },
      { key: "burned", header: "PYRE burned", numeric: true, render: (r) => <span className="text-burn">{formatTokenUnits(r.burnedUnits)}</span> },
      { key: "pct", header: "% supply", numeric: true, render: (r) => formatPct(r.burnedPctOfSupply / 100, 4) },
      { key: "eth", header: "ETH", numeric: true, render: (r) => formatEth(r.ethWei) },
      { key: "source", header: "Fee share", numeric: true, collapse: true, render: (r) => <span className="num text-ink-2">{formatUsd(r.usdMicros)}</span> },
      { key: "swapTx", header: "Swap tx", collapse: true, render: (r) => (r.swapTx ? <TxLink hash={r.swapTx} chars={3} copy={false} /> : <span className="text-ink-3">—</span>) },
      { key: "burnTx", header: "Burn tx", collapse: true, render: (r) => (r.burnTx ? <TxLink hash={r.burnTx} chars={3} copy={false} /> : <span className="text-ink-3">—</span>) },
      { key: "attest", header: "Attestation", collapse: true, render: (r) => <AttestationCell row={r} /> },
    ],
    [],
  );
  // Before the first burn there is nothing to chart or filter; the ledger is one empty state.
  const empty = burns.isSuccess && all.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="eyebrow">Ledger</div>
          <h1 className="h1 mt-1 text-ink">
            PYRE <em>burns</em>
          </h1>
          <p className="body mt-2 max-w-xl text-ink-2">
            25% of every coin's creator fees buys{" "}
            <Link to="/pyre" className="text-ink underline underline-offset-2 hover:text-accent">
              $PYRE
            </Link>{" "}
            on the curve or the pool, and the tokens are destroyed for good.
          </p>
        </div>
        {totals ? (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
            <div>
              <dt className="eyebrow">ETH burned</dt>
              <dd className="mt-1">
                <TickFlash value={totals.ethWei} tone="burn">
                  <EthFlow wei={BigInt(totals.ethWei)} digits={3} className="figure figure-lg text-burn" />
                </TickFlash>
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Burns</dt>
              <dd className="mt-1">
                <NumberFlow value={totals.burns} className="figure figure-lg text-ink" />
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Fee share spent</dt>
              <dd className="figure figure-lg mt-1 text-ink">{formatUsd(totals.usdMicros, 0)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Last burn</dt>
              <dd className="figure figure-lg mt-1 text-ink">{last ? timeAgo(last.createdAt) : "—"}</dd>
            </div>
          </dl>
        ) : (
          <Skeleton className="h-14 w-full max-w-md" />
        )}
      </header>

      {!empty && (
        <Card padding="md">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <div className="eyebrow">Cumulative ETH burned</div>
              <div className="num text-13 text-ink-2">
                {formatEth(viewEth)} {filtered ? "in this view" : "all time"} {totals && <span className="text-ink-3">· {formatUsd(totals.usdMicros)} of fee share</span>}
              </div>
            </div>
            {filtered && (
              <Chip tone="accent" size="sm" mono>
                {rows.length} of {all.length} rows
              </Chip>
            )}
          </div>
          {burns.isPending ? <Skeleton className="h-[220px] w-full" rounded="card" /> : <AreaChart points={series} tone="burn" height={220} formatValue={(v) => `${v.toFixed(4)} ETH`} label="Cumulative ETH spent on PYRE burns over time" />}
        </Card>
      )}

      <section className="flex flex-col gap-3" aria-label="Burns">
        {!empty && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From" className="w-40">
              <Input type="date" mono value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To" className="w-40">
              <Input type="date" mono value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </Field>
            {filtered && (
              <Button
                variant="ghost"
                size="md"
                onClick={() => {
                  setFrom("");
                  setTo("");
                }}
              >
                Clear
              </Button>
            )}
            <Button variant="secondary" size="md" className="ml-auto" disabled={rows.length === 0} onClick={() => downloadText(`pyre-burns-${new Date().toISOString().slice(0, 10)}.csv`, burnsCsv(rows))}>
              Export CSV
            </Button>
          </div>
        )}

        {burns.isPending ? (
          <Skeleton lines={10} />
        ) : empty ? (
          <EmptyState className="min-h-[50svh]" title="No burns yet" body="The first burn fires once the PYRE_TOKEN ledger clears $5 of fee share. It will appear here with its swap, burn and attestation transactions." />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing in this range" body="Widen the dates." />
        ) : (
          <Card padding={0} className="overflow-hidden">
            <Table columns={columns} rows={rows} rowKey={(r) => r.id} caption="PYRE burn ledger" dense />
          </Card>
        )}
        {!empty && (
          <div className="flex items-center justify-between text-12 text-ink-3">
            <span className="num">{all.length.toLocaleString("en-US")} loaded{burns.hasNextPage ? " · more available" : ""}</span>
            {burns.hasNextPage && (
              <Button variant="ghost" size="sm" onClick={() => void burns.fetchNextPage()} loading={burns.isFetchingNextPage}>
                Load older
              </Button>
            )}
          </div>
        )}
      </section>

      <footer className="small max-w-3xl text-ink-3">
        <p>
          Burns call <code className="num">burn()</code> on the $PYRE token, which lowers <code className="num">totalSupply</code> — nothing is parked in a wallet. The burned percentage on the $PYRE page is read from that supply delta, and any legacy transfers to the dead address{" "}
          <a href={explorerAddress(DEAD_ADDRESS)} target="_blank" rel="noreferrer" className="num text-ink-2 hover:text-ink">
            {DEAD_ADDRESS.slice(0, 8)}…dEaD
          </a>{" "}
          count too. Each row carries a swap tx, a burn tx and an attestation tx you can open on Blockscout.
        </p>
      </footer>
    </div>
  );
};
