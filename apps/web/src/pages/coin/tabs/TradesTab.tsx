import { useEffect, useMemo, useRef, useState } from "react";
import type { AppDetailDto, TradeDto } from "@pyre/shared";
import { venueOf } from "@pyre/shared";
import { AddressLink, TxLink } from "../../../components/TxLink.js";
import { formatNative, formatTokenUnits, formatUsd, nativeUsdMicros, timeAgo } from "../../../lib/format.js";
import { useVenueLinks } from "../../../lib/venue.js";
import { Button, EmptyState, Skeleton, Table, cx, type Column } from "../../../ui/index.js";

interface Props {
  app: AppDetailDto;
  /** REST pages, newest first. */
  rows: ReadonlyArray<TradeDto> | undefined;
  /** Stream arrivals, newest first. */
  live: ReadonlyArray<TradeDto>;
  /** USD price of the app's native asset. */
  nativePriceUsd: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

/** Merges live and fetched trades by tx hash, newest first. */
export const mergeTrades = (live: ReadonlyArray<TradeDto>, fetched: ReadonlyArray<TradeDto>): TradeDto[] => {
  const seen: Record<string, true> = {};
  const out: TradeDto[] = [];
  for (const t of [...live, ...fetched]) {
    if (seen[t.txHash]) continue;
    seen[t.txHash] = true;
    out.push(t);
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return out;
};

/** Ticks every 10s so ages stay honest without re-rendering on every frame. */
const useNow = (ms = 10_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
};

/**
 * The tape. New fills flash in at the top; while the pointer rests on the
 * table the tape holds so a row cannot slide out from under a click, and the
 * held fills are released on leave.
 */
export const TradesTab = ({ app, rows, live, nativePriceUsd, hasMore, loadingMore, onLoadMore }: Props) => {
  const now = useNow();
  const [paused, setPaused] = useState(false);
  const shown = useRef<TradeDto[]>([]);
  const merged = useMemo(() => mergeTrades(live, rows ?? []), [live, rows]);
  if (!paused) shown.current = merged;
  const visible = shown.current;
  const held = paused ? merged.length - visible.length : 0;
  const venue = venueOf(app);
  const links = useVenueLinks(app);
  const solana = venue.chain === "solana";

  const columns = useMemo<Column<TradeDto>[]>(
    () => [
      {
        key: "side",
        header: "Side",
        width: 72,
        render: (r) => (
          <span className={cx("num inline-flex items-center gap-1 font-medium", r.side === "BUY" ? "text-earn" : "text-burn")}>
            {r.side === "BUY" ? "↗" : "↙"} {r.side === "BUY" ? "buy" : "sell"}
          </span>
        ),
      },
      { key: "tokens", header: `$${app.ticker}`, numeric: true, render: (r) => formatTokenUnits(r.tokenUnits, { decimals: venue.tokenDecimals }) },
      { key: "native", header: venue.native.symbol, numeric: true, render: (r) => formatNative(r.quoteWei, venue.native) },
      { key: "usd", header: "USD", numeric: true, collapse: true, render: (r) => formatUsd(nativeUsdMicros(r.quoteWei, venue.native, nativePriceUsd)) },
      { key: "wallet", header: "Wallet", collapse: true, render: (r) => <AddressLink address={r.wallet} chars={4} copy={false} venue={links} /> },
      { key: "venue", header: "Venue", collapse: true, render: (r) => <span className="text-ink-3">{r.venue === "CURVE" ? "curve" : solana ? "pumpswap" : "v4"}</span> },
      { key: "age", header: "Age", numeric: true, width: 72, render: (r) => <span className="text-ink-2">{timeAgo(r.ts, now)}</span> },
      { key: "tx", header: "Tx", width: 40, render: (r) => <TxLink hash={r.txHash} chars={2} copy={false} venue={links} /> },
    ],
    [app.ticker, venue, links, solana, nativePriceUsd, now],
  );

  if (!rows) return <Skeleton lines={8} />;
  if (visible.length === 0) return <EmptyState title="No trades yet" body={`Fills on the curve or the ${solana ? "PumpSwap" : "v4"} pool stream in here as they land.`} />;

  return (
    <div className="flex flex-col gap-3">
      <div onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <Table columns={columns} rows={visible} rowKey={(r) => r.txHash} maxHeight={520} dense caption={`Trades of $${app.ticker}`} rowClassName={(r) => (live.some((l) => l.txHash === r.txHash) ? "animate-fade-in" : undefined)} />
      </div>
      <div className="flex items-center justify-between text-12 text-ink-3">
        <span className="num" aria-live="polite">
          {paused ? (held > 0 ? `paused · ${held} new` : "paused while you hover") : `${visible.length} trades · live`}
        </span>
        {hasMore && (
          <Button variant="ghost" size="sm" onClick={onLoadMore} loading={loadingMore}>
            Load older
          </Button>
        )}
      </div>
    </div>
  );
};
