import { useMemo } from "react";
import type { AppDetailDto, CoinBurnDto } from "@pyre/shared";
import { venueOf } from "@pyre/shared";
import { TxLink } from "../../../components/TxLink.js";
import { formatNative, formatPct, formatTokenUnits, formatUsd, timeAgo } from "../../../lib/format.js";
import { useVenueLinks } from "../../../lib/venue.js";
import { Button, EmptyState, Skeleton, Table, type Column } from "../../../ui/index.js";
import { useCoinBurns } from "../queries.js";

/**
 * The coin's own burn ledger (Solana apps). Every row is the treasury buying `$TICKER` with the
 * app's 25% fee share, burning it (`burnChecked`) and attesting the fee claims it came from with
 * a memo transaction. Newest first.
 */
export const BurnsTab = ({ app }: { app: AppDetailDto }) => {
  const venue = venueOf(app);
  const links = useVenueLinks(app);
  const burns = useCoinBurns(app.slug, app.coinBurns !== null);
  const rows = useMemo(() => burns.data?.pages.flatMap((p) => p.items) ?? [], [burns.data]);
  const totals = app.coinBurns;

  const columns = useMemo<Column<CoinBurnDto>[]>(
    () => [
      { key: "when", header: "When", render: (b) => <span className="text-ink-2">{timeAgo(b.createdAt)}</span> },
      { key: "spent", header: `${venue.native.symbol} spent`, numeric: true, render: (b) => formatNative(b.nativeWei, venue.native) },
      { key: "burned", header: "Burned", numeric: true, render: (b) => <span className="text-burn">{formatTokenUnits(b.burnedUnits, { decimals: venue.tokenDecimals })}</span> },
      { key: "pct", header: "% supply", numeric: true, collapse: true, render: (b) => formatPct(b.burnedPctOfSupply / 100, 4) },
      { key: "src", header: "Fee share", numeric: true, collapse: true, render: (b) => formatUsd(b.usdMicros) },
      { key: "swap", header: "Swap", collapse: true, render: (b) => (b.swapTx ? <TxLink hash={b.swapTx} chars={3} copy={false} venue={links} /> : <span className="text-ink-3">—</span>) },
      { key: "burn", header: "Burn", render: (b) => (b.burnTx ? <TxLink hash={b.burnTx} chars={3} copy={false} venue={links} /> : <span className="text-ink-3">pending</span>) },
      { key: "attest", header: "Attest", collapse: true, render: (b) => (b.attestTx ? <TxLink hash={b.attestTx} chars={3} copy={false} venue={links} /> : <span className="text-ink-3">—</span>) },
    ],
    [venue, links],
  );

  if (!totals) return <EmptyState title="This coin's fees burn PYRE" body="On Robinhood Chain the 25% fee share buys and burns PYRE, not the coin. See the global burn ledger." />;

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-4 rounded-card border border-line bg-surface p-4 sm:grid-cols-4">
        <div>
          <dt className="eyebrow">Burned</dt>
          <dd className="num text-18 text-burn">{formatTokenUnits(totals.burnedUnits, { decimals: venue.tokenDecimals })}</dd>
          <dd className="small text-ink-3">{formatPct(totals.burnedPctOfSupply / 100, 3)} of supply</dd>
        </div>
        <div>
          <dt className="eyebrow">{venue.native.symbol} spent</dt>
          <dd className="num text-18 text-ink">{formatNative(totals.nativeWei, venue.native)}</dd>
          <dd className="small text-ink-3">{totals.count} burns</dd>
        </div>
        <div>
          <dt className="eyebrow">Pending</dt>
          <dd className="num text-18 text-ink">{formatUsd(totals.pendingMicros)}</dd>
          <dd className="small text-ink-3">burns at $5</dd>
        </div>
        <div>
          <dt className="eyebrow">Last burn</dt>
          <dd className="num text-18 text-ink">{totals.last ? timeAgo(totals.last.createdAt) : "—"}</dd>
          <dd className="small text-ink-3">{totals.last?.attestTx ? "attested" : totals.last ? "attestation pending" : "none yet"}</dd>
        </div>
      </dl>
      {burns.isPending ? (
        <Skeleton lines={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="No burns yet" body={`The first burn happens once this coin's fee share clears $5. The treasury buys $${app.ticker}, burns it and attests the claims it came from.`} />
      ) : (
        <>
          <Table columns={columns} rows={rows} rowKey={(b) => b.id} dense caption={`$${app.ticker} burn history`} />
          {burns.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" loading={burns.isFetchingNextPage} onClick={() => void burns.fetchNextPage()}>
                Older burns
              </Button>
            </div>
          )}
        </>
      )}
      <p className="small text-ink-3">
        Every row is a swap, a <span className="num">burnChecked</span> that lowers the mint's supply for good, and a memo transaction carrying the hash of the fee claims that paid for it. Burns
        reduce supply; nothing is paid to holders. PYRE lives on Robinhood Chain only, so no PYRE is bought here.
      </p>
    </div>
  );
};
