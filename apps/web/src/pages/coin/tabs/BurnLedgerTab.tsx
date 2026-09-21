import { useMemo, useState } from "react";
import type { BuybackDto } from "@pyre/shared";
import { TxLink } from "../../../components/TxLink.js";
import { formatEth, formatPct, formatTokenUnits, formatUsd, timeAgo } from "../../../lib/format.js";
import { Button, Chip, EmptyState, Table, cx, type ChipTone, type Column } from "../../../ui/index.js";

const STATUS: Record<BuybackDto["status"], { label: string; tone: ChipTone }> = {
  PENDING: { label: "pending", tone: "warn" },
  SWAPPING: { label: "swapping", tone: "build" },
  SWAPPED: { label: "swapped", tone: "build" },
  BURNED: { label: "burned", tone: "burn" },
  FAILED: { label: "failed", tone: "neutral" },
};

/** Cooling: a fresh row enters white-hot and tempers to the accent over 1.2s; the tint follows `currentColor`. */
export const coolingRow = (fresh: boolean): string | undefined =>
  fresh ? "animate-cool bg-[color-mix(in_oklab,currentColor_10%,transparent)]" : undefined;

/** Attestation: how anyone can check a burn was paid for by real revenue. */
export const AttestationCell = ({ row }: { row: BuybackDto }) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center gap-1.5">
      <span className="num text-ink-2" title={row.attestHash}>
        {row.attestHash ? `${row.attestHash.slice(0, 10)}…` : "—"}
      </span>
      {row.attestTx && <TxLink hash={row.attestTx} chars={3} copy={false} />}
      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-12" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        verify
      </Button>
      {open && (
        <span
          role="dialog"
          aria-label="How to verify this burn"
          className="absolute right-0 top-full z-20 mt-1 w-72 rounded-card border border-line-2 bg-raised p-3 text-left text-12 leading-4 text-ink-2 animate-rise"
        >
          <span className="eyebrow block text-ink-3">Verify on Blockscout</span>
          <span className="mt-1 block">
            The attest tx is a zero-value self-transfer from the treasury whose calldata is <code className="num">0x5059524501</code> (“PYRE”, v1) followed by{" "}
            <code className="num">sha256</code> of the {row.revenueEventIds} revenue-event ids that funded this buyback, sorted and comma-joined.
          </span>
          <span className="num mt-1.5 block break-all text-ink-3">{row.attestHash || "hash pending"}</span>
          <span className="mt-1.5 block">Swap and burn txs sit beside it; the burn reduces the token’s totalSupply.</span>
        </span>
      )}
    </span>
  );
};

interface Props {
  ticker: string;
  rows: ReadonlyArray<BuybackDto>;
  fresh: ReadonlySet<string>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export const BurnLedgerTab = ({ ticker, rows, fresh, hasMore, loadingMore, onLoadMore }: Props) => {
  const columns = useMemo<Column<BuybackDto>[]>(
    () => [
      { key: "time", header: "Time", width: 96, render: (r) => <span className="num text-ink-2">{timeAgo(r.completedAt ?? r.createdAt)}</span> },
      { key: "status", header: "Status", width: 96, render: (r) => <Chip tone={STATUS[r.status].tone} size="sm" mono>{STATUS[r.status].label}</Chip> },
      { key: "revenue", header: "Revenue", numeric: true, render: (r) => formatUsd(r.revenueMicros) },
      { key: "eth", header: "ETH", numeric: true, render: (r) => formatEth(r.ethWei) },
      { key: "burned", header: `Burned $${ticker}`, numeric: true, render: (r) => <span className="text-burn">{formatTokenUnits(r.tokensBurnedUnits)}</span> },
      { key: "pct", header: "% supply", numeric: true, render: (r) => formatPct(r.burnedPctOfSupply / 100, 4) },
      {
        key: "txs",
        header: "Swap · burn",
        collapse: true,
        render: (r) => (
          <span className="inline-flex items-center gap-2">
            {r.swapTx ? <TxLink hash={r.swapTx} chars={3} copy={false} /> : <span className="text-ink-3">—</span>}
            {r.burnTx ? <TxLink hash={r.burnTx} chars={3} copy={false} /> : <span className="text-ink-3">—</span>}
          </span>
        ),
      },
      { key: "attest", header: "Attestation", collapse: true, render: (r) => <AttestationCell row={r} /> },
    ],
    [ticker],
  );

  if (rows.length === 0) {
    return <EmptyState title="No burns yet" body="The first buyback fires once the app has earned $5 of revenue. Every one lands here with its swap, burn and attestation." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={(r) => cx(coolingRow(fresh.has(r.id)), r.status === "FAILED" && "ash")}
        maxHeight={520}
        caption={`Buybacks and burns of $${ticker}`}
        dense
      />
      <div className="flex items-center justify-between text-12 text-ink-3">
        <span className="num">{rows.length} buybacks · new rows enter white-hot and cool</span>
        {hasMore && (
          <Button variant="ghost" size="sm" onClick={onLoadMore} loading={loadingMore}>
            Load older
          </Button>
        )}
      </div>
    </div>
  );
};
