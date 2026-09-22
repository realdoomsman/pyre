import { useMemo, useState } from "react";
import type { AppDetailDto, HolderDto, TradeDto } from "@pyre/shared";
import { venueOf } from "@pyre/shared";
import { formatCount, formatNative, formatPct, formatUsd, nativeToNumber, type NativeUnit } from "../../lib/format.js";
import { Card, Tabs, cx } from "../../ui/index.js";

const WINDOWS = [
  { id: "5m", label: "5m", ms: 5 * 60_000 },
  { id: "1h", label: "1h", ms: 60 * 60_000 },
  { id: "24h", label: "24h", ms: 24 * 60 * 60_000 },
] as const;
type WindowId = (typeof WINDOWS)[number]["id"];

const VIEWS = [
  { id: "stats", label: "Stats" },
  { id: "audit", label: "Audit" },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

interface WindowStats {
  buys: number;
  sells: number;
  buyVolUsd: number;
  sellVolUsd: number;
  buyers: number;
  sellers: number;
  /** True when the loaded tape does not reach back to the window start. */
  partial: boolean;
  priceChangePct: number | null;
}

const windowStats = (trades: ReadonlyArray<TradeDto>, ms: number, native: NativeUnit, nativePriceUsd: number, now: number): WindowStats => {
  const since = now - ms;
  const buyerSet: Record<string, true> = {};
  const sellerSet: Record<string, true> = {};
  let buys = 0;
  let sells = 0;
  let buyVol = 0;
  let sellVol = 0;
  let oldest: TradeDto | null = null;
  let newest: TradeDto | null = null;
  for (const t of trades) {
    const ts = new Date(t.ts).getTime();
    if (ts < since) continue;
    const usd = nativeToNumber(t.quoteWei, native) * nativePriceUsd;
    if (t.side === "BUY") {
      buys++;
      buyVol += usd;
      buyerSet[t.wallet] = true;
    } else {
      sells++;
      sellVol += usd;
      sellerSet[t.wallet] = true;
    }
    if (!oldest || ts < new Date(oldest.ts).getTime()) oldest = t;
    if (!newest || ts > new Date(newest.ts).getTime()) newest = t;
  }
  const last = trades[trades.length - 1];
  const partial = trades.length > 0 && !!last && new Date(last.ts).getTime() > since;
  const priceChangePct = oldest && newest && oldest !== newest && oldest.priceUsd > 0 ? (newest.priceUsd / oldest.priceUsd - 1) * 100 : null;
  return { buys, sells, buyVolUsd: buyVol, sellVolUsd: sellVol, buyers: Object.keys(buyerSet).length, sellers: Object.keys(sellerSet).length, partial, priceChangePct };
};

const PairBar = ({ label, a, b, fmt }: { label: string; a: number; b: number; fmt: (n: number) => string }) => {
  const total = a + b;
  const pct = total > 0 ? (a / total) * 100 : 50;
  return (
    <div>
      <div className="flex items-center justify-between text-12">
        <span className="eyebrow">{label}</span>
        <span className="num text-ink-2">
          <span className="text-earn">{fmt(a)}</span> <span className="text-ink-3">/</span> <span className="text-burn">{fmt(b)}</span>
        </span>
      </div>
      <div className="mt-1 flex h-1.5 w-full gap-px overflow-hidden rounded-pill bg-fill-2" aria-hidden>
        <span className="h-full bg-earn transition-[width] duration-(--duration-reveal) ease-(--ease-reveal)" style={{ width: `${pct}%` }} />
        <span className="h-full flex-1 bg-burn" />
      </div>
    </div>
  );
};

const Line = ({ k, v, tone }: { k: string; v: string; tone?: "burn" | "earn" }) => (
  <div className="flex items-baseline justify-between gap-3 py-1.5">
    <dt className="text-13 text-ink-2">{k}</dt>
    <dd className={cx("num text-13 font-medium", tone === "burn" ? "text-burn" : tone === "earn" ? "text-earn" : "text-ink")}>{v}</dd>
  </div>
);

interface Props {
  app: AppDetailDto;
  trades: ReadonlyArray<TradeDto>;
  holders: ReadonlyArray<HolderDto>;
  /** USD price of the app's native asset (ETH or SOL). */
  nativePriceUsd: number;
}

/** Windowed trade stats beside the audit: fees, fees→agent, fees→burn, holder concentration. */
export const StatsAudit = ({ app, trades, holders, nativePriceUsd }: Props) => {
  const [view, setView] = useState<ViewId>("stats");
  const [win, setWin] = useState<WindowId>("24h");
  const venue = venueOf(app);
  const native = venue.native;
  const stats = useMemo(() => windowStats(trades, WINDOWS.find((w) => w.id === win)!.ms, native, nativePriceUsd, Date.now()), [trades, win, native, nativePriceUsd]);
  const top10 = holders.filter((h) => h.tag === null).slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const creator = holders.filter((h) => h.tag === "launcher").reduce((s, h) => s + h.pct, 0);
  const feesWei = BigInt(app.feesWei);
  const burnBps = app.feeSplit.pyreToken + app.feeSplit.coinBurn;
  const usd = (n: number) => formatUsd(BigInt(Math.round(n * 1e6)));

  return (
    <Card as="section" aria-label="Stats and audit">
      <Tabs items={VIEWS} value={view} onChange={setView} name="stats-view" variant="line" size="sm" className="mb-3" />
      {view === "stats" ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Tabs items={WINDOWS} value={win} onChange={setWin} name="stats-window" variant="pill" size="sm" />
            <span className={cx("num text-13 font-medium", stats.priceChangePct == null ? "text-ink-3" : stats.priceChangePct >= 0 ? "text-earn" : "text-burn")}>
              {stats.priceChangePct == null ? "—" : `${stats.priceChangePct >= 0 ? "▲" : "▼"} ${Math.abs(stats.priceChangePct).toFixed(1)}%`}
            </span>
          </div>
          <dl className="divide-y divide-line">
            <Line k="Volume" v={usd(stats.buyVolUsd + stats.sellVolUsd)} />
            <Line k="Trades" v={String(stats.buys + stats.sells)} />
          </dl>
          <PairBar label="Buys / sells" a={stats.buys} b={stats.sells} fmt={String} />
          <PairBar label="Buy vol / sell vol" a={stats.buyVolUsd} b={stats.sellVolUsd} fmt={usd} />
          <PairBar label="Buyers / sellers" a={stats.buyers} b={stats.sellers} fmt={String} />
          {stats.partial && <p className="num text-12 text-ink-3">from the latest {trades.length} trades</p>}
        </div>
      ) : (
        <dl className="divide-y divide-line">
          <Line k="Holders" v={formatCount(app.holders)} />
          <Line k="Top 10" v={formatPct(top10 / 100, 1)} />
          <Line k="Launcher" v={formatPct(creator / 100, 2)} />
          <Line k="Total fees claimed" v={formatNative(feesWei, native)} tone="earn" />
          <Line k="Fees → agent" v={formatNative((feesWei * BigInt(app.feeSplit.buildBudget)) / 10_000n, native)} tone="earn" />
          <Line k="Fees accruing" v={formatNative(BigInt(app.unsweptWei) + BigInt(app.escrowWei), native)} />
          <Line k={venue.chain === "solana" ? `Fees → $${app.ticker} burn` : "Fees → PYRE burn"} v={formatNative((feesWei * BigInt(burnBps)) / 10_000n, native)} tone="burn" />
          <Line k="Creator tax" v="0%" />
          <Line k="Uptime" v={formatPct(app.uptimeBps / 10_000, 1)} tone={app.healthy ? "earn" : undefined} />
        </dl>
      )}
    </Card>
  );
};
