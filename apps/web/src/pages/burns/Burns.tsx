import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { BurnLedgerRowDto } from "@pyre/shared";
import { DEAD_ADDRESS } from "@pyre/chain/browser";
import { flatPages, useBurns, useGlobalStream } from "../../api/queries.js";
import type { GlobalFrame } from "../../api/types.js";
import { TxLink } from "../../components/TxLink.js";
import { explorerAddress } from "../../env.js";
import { formatCount, formatEth, formatPct, formatTokenUnits, formatUsd, timeAgo } from "../../lib/format.js";
import { Button, Card, Chip, EmptyState, EthFlow, Field, Input, NumberFlow, Select, Skeleton, Table, TickFlash, cx, type Column } from "../../ui/index.js";
import { AttestationCell, coolingRow } from "../coin/tabs/BurnLedgerTab.js";
import { AreaChart, type AreaPoint } from "./AreaChart.js";
import { burnsCsv, downloadText } from "./csv.js";

const COOL_MS = 1400;

/** Marks buybacks that arrive on the global stream so their rows enter white-hot. */
const useFreshBurns = (): ReadonlySet<string> => {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    [],
  );
  const onFrame = useCallback((frame: GlobalFrame) => {
    const p = frame.event?.payload;
    if (!p || p.type !== "BUYBACK") return;
    const id = p.buybackId;
    setFresh((cur) => new Set(cur).add(id));
    timers.current.push(
      window.setTimeout(() => {
        setFresh((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        });
      }, COOL_MS),
    );
  }, []);
  useGlobalStream(onFrame);
  return fresh;
};

const dayStart = (s: string): number | null => (s ? new Date(`${s}T00:00:00`).getTime() : null);
const dayEnd = (s: string): number | null => (s ? new Date(`${s}T23:59:59.999`).getTime() : null);

/** `/burns` — every buyback-and-burn across Pyre, newest first, cooling as it ages. */
export const Burns = () => {
  useEffect(() => {
    document.title = "Burn ledger — Pyre";
  }, []);
  const burns = useBurns();
  const fresh = useFreshBurns();
  const [coin, setCoin] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const all = useMemo(() => flatPages(burns.data?.pages), [burns.data]);
  const totals = burns.data?.pages[0]?.totals;
  const tickers = useMemo(() => {
    const seen: Record<string, string> = {};
    for (const r of all) seen[r.slug] = r.ticker;
    return Object.entries(seen).sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);

  const rows = useMemo(() => {
    const f = dayStart(from);
    const t = dayEnd(to);
    return all.filter((r) => {
      if (coin && r.slug !== coin) return false;
      const ts = new Date(r.completedAt ?? r.createdAt).getTime();
      if (f !== null && ts < f) return false;
      if (t !== null && ts > t) return false;
      return true;
    });
  }, [all, coin, from, to]);

  const filtered = coin !== "" || from !== "" || to !== "";
  // Unfiltered: the API's running total per row is exact all-time; a filtered view re-accumulates locally.
  const series = useMemo<AreaPoint[]>(() => {
    const asc = rows.slice().reverse();
    let cum = 0;
    return asc.map((r) => {
      cum += Number(r.ethWei) / 1e18;
      return { t: new Date(r.completedAt ?? r.createdAt).getTime(), v: filtered ? cum : Number(r.cumulativeEthWei) / 1e18 };
    });
  }, [rows, filtered]);
  const viewEth = useMemo(() => (filtered ? rows.reduce((s, r) => s + BigInt(r.ethWei), 0n) : BigInt(totals?.ethWei ?? "0")), [rows, filtered, totals]);
  const last = all[0];

  const columns = useMemo<Column<BurnLedgerRowDto>[]>(
    () => [
      { key: "time", header: "Time", width: 96, render: (r) => <span className="num text-ink-2">{timeAgo(r.completedAt ?? r.createdAt)}</span> },
      {
        key: "coin",
        header: "Coin",
        render: (r) => (
          <Link to={`/c/${r.slug}`} className="num font-medium text-ink hover:text-accent">
            ${r.ticker}
          </Link>
        ),
      },
      { key: "burned", header: "Tokens burned", numeric: true, render: (r) => <span className="text-burn">{formatTokenUnits(r.tokensBurnedUnits)}</span> },
      { key: "pct", header: "% supply", numeric: true, render: (r) => formatPct(r.burnedPctOfSupply / 100, 4) },
      { key: "eth", header: "ETH", numeric: true, render: (r) => formatEth(r.ethWei) },
      {
        key: "source",
        header: "Revenue source",
        collapse: true,
        render: (r) => (
          <span className="num text-ink-2">
            {formatUsd(r.revenueMicros)} <span className="text-ink-3">· {r.revenueEventIds} events</span>
          </span>
        ),
      },
      { key: "burnTx", header: "Burn tx", collapse: true, render: (r) => (r.burnTx ? <TxLink hash={r.burnTx} chars={3} copy={false} /> : <span className="text-ink-3">—</span>) },
      { key: "attest", header: "Attestation", collapse: true, render: (r) => <AttestationCell row={r} /> },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="eyebrow">Ledger</div>
          <h1 className="h1 mt-1 text-ink">
            Burn <em>ledger</em>
          </h1>
          <p className="body mt-2 max-w-xl text-ink-2">Every buyback-and-burn on Pyre. App revenue buys the coin back on the curve or the pool, and the tokens are destroyed for good.</p>
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
              <dt className="eyebrow">Buybacks</dt>
              <dd className="mt-1">
                <NumberFlow value={totals.buybacks} className="figure figure-lg text-ink" />
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Coins</dt>
              <dd className="figure figure-lg mt-1 text-ink">{formatCount(totals.coins)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Last burn</dt>
              <dd className="figure figure-lg mt-1 text-ink">{last ? timeAgo(last.completedAt ?? last.createdAt) : "—"}</dd>
            </div>
          </dl>
        ) : (
          <Skeleton className="h-14 w-full max-w-md" />
        )}
      </header>

      <Card padding="md">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="eyebrow">Cumulative ETH burned</div>
            <div className="num text-13 text-ink-2">
              {formatEth(viewEth)} {filtered ? "in this view" : "all time"} {totals && <span className="text-ink-3">· {formatUsd(totals.revenueMicros)} of revenue</span>}
            </div>
          </div>
          {filtered && (
            <Chip tone="accent" size="sm" mono>
              {rows.length} of {all.length} rows
            </Chip>
          )}
        </div>
        {burns.isPending ? <Skeleton className="h-[220px] w-full" rounded="card" /> : <AreaChart points={series} tone="burn" height={220} formatValue={(v) => `${v.toFixed(4)} ETH`} label="Cumulative ETH spent on buybacks over time" />}
      </Card>

      <section className="flex flex-col gap-3" aria-label="Burns">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Coin" className="w-40">
            <Select value={coin} onChange={(e) => setCoin(e.target.value)}>
              <option value="">All coins</option>
              {tickers.map(([slug, ticker]) => (
                <option key={slug} value={slug}>
                  ${ticker}
                </option>
              ))}
            </Select>
          </Field>
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
                setCoin("");
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

        {burns.isPending ? (
          <Skeleton lines={10} />
        ) : all.length === 0 ? (
          <EmptyState title="No burns yet" body="The first fires when any app on Pyre has earned $5. Watch this page cool as they land." />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing in this range" body="Widen the dates or pick another coin." />
        ) : (
          <Card padding={0} className="overflow-hidden">
            <Table
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              rowClassName={(r) => cx(coolingRow(fresh.has(r.id)), r.status === "FAILED" && "ash")}
              caption="Global burn ledger"
              dense
            />
          </Card>
        )}
        <div className="flex items-center justify-between text-12 text-ink-3">
          <span className="num">{all.length.toLocaleString("en-US")} loaded{burns.hasNextPage ? " · more available" : ""}</span>
          {burns.hasNextPage && (
            <Button variant="ghost" size="sm" onClick={() => void burns.fetchNextPage()} loading={burns.isFetchingNextPage}>
              Load older
            </Button>
          )}
        </div>
      </section>

      <footer className="small max-w-3xl text-ink-3">
        <p>
          Burns call <code className="num">burn()</code> on the token, which lowers <code className="num">totalSupply</code> — nothing is parked in a wallet. The burned percentage on every coin page is read from that supply delta, and any legacy transfers to the dead address{" "}
          <a href={explorerAddress(DEAD_ADDRESS)} target="_blank" rel="noreferrer" className="num text-ink-2 hover:text-ink">
            {DEAD_ADDRESS.slice(0, 8)}…dEaD
          </a>{" "}
          count too. Each row carries a swap tx, a burn tx and an attestation tx you can open on Blockscout.
        </p>
      </footer>
    </div>
  );
};
