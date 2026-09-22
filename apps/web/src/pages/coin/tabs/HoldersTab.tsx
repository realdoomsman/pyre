import { useMemo } from "react";
import type { AppDetailDto, HolderDto } from "@pyre/shared";
import { AddressLink } from "../../../components/TxLink.js";
import { formatPct, formatTokenUnits, formatUsd } from "../../../lib/format.js";
import { Chip, EmptyState, Skeleton, Table, cx, type ChipTone, type Column } from "../../../ui/index.js";
import type { HoldersDto } from "../queries.js";

const TAG: Record<NonNullable<HolderDto["tag"]>, { label: string; tone: ChipTone }> = {
  curve: { label: "curve", tone: "accent" },
  pool: { label: "pool", tone: "accent" },
  locker: { label: "locker", tone: "accent" },
  vault: { label: "vault", tone: "accent" },
  treasury: { label: "treasury", tone: "build" },
  launcher: { label: "launcher", tone: "earn" },
  dead: { label: "dead address", tone: "neutral" },
};

interface Segment {
  key: string;
  label: string;
  pct: number;
  className: string;
}

/** Distribution: who holds what share of the full 1B supply. */
const segments = (holders: ReadonlyArray<HolderDto>): Segment[] => {
  const wallets = holders.filter((h) => h.tag === null);
  const top10 = wallets.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const creator = holders.filter((h) => h.tag === "launcher").reduce((s, h) => s + h.pct, 0);
  const pool = holders.filter((h) => h.tag === "curve" || h.tag === "pool" || h.tag === "locker" || h.tag === "vault").reduce((s, h) => s + h.pct, 0);
  const treasury = holders.filter((h) => h.tag === "treasury").reduce((s, h) => s + h.pct, 0);
  const rest = Math.max(0, 100 - top10 - creator - pool - treasury);
  return [
    { key: "top10", label: "Top 10", pct: top10, className: "bg-ink" },
    { key: "creator", label: "Launcher", pct: creator, className: "bg-earn" },
    { key: "pool", label: "Curve / pool / locker", pct: pool, className: "bg-accent" },
    { key: "treasury", label: "Treasury", pct: treasury, className: "bg-build" },
    { key: "rest", label: "Everyone else", pct: rest, className: "bg-ink-3" },
  ].filter((s) => s.pct > 0.0005);
};

interface Props {
  app: AppDetailDto;
  data: HoldersDto | undefined;
}

export const HoldersTab = ({ app, data }: Props) => {
  const rows = data?.holders ?? [];
  const dist = useMemo(() => segments(rows), [rows]);
  const columns = useMemo<Column<HolderDto>[]>(
    () => [
      { key: "rank", header: "#", width: 40, render: (_r, i) => <span className="num text-ink-3">{i + 1}</span> },
      {
        key: "address",
        header: "Holder",
        render: (r) => (
          <span className="inline-flex items-center gap-2">
            <AddressLink address={r.address} chars={4} />
            {r.tag && (
              <Chip tone={TAG[r.tag].tone} size="sm" mono>
                {TAG[r.tag].label}
              </Chip>
            )}
          </span>
        ),
      },
      { key: "units", header: "Tokens", numeric: true, render: (r) => formatTokenUnits(r.units) },
      { key: "pct", header: "% supply", numeric: true, render: (r) => formatPct(r.pct / 100, 2) },
      { key: "value", header: "Value", numeric: true, collapse: true, render: (r) => formatUsd(BigInt(Math.round((Number(r.units) / 1e18) * app.priceUsd * 1e6))) },
    ],
    [app.priceUsd],
  );

  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-3 w-full" rounded="pill" />
        <Skeleton lines={8} />
      </div>
    );
  }
  if (rows.length === 0) return <EmptyState title="No holders indexed yet" body="Holder balances are indexed from the chain a few minutes after launch." />;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex h-3 w-full overflow-hidden rounded-pill bg-fill-2" role="img" aria-label={dist.map((s) => `${s.label} ${formatPct(s.pct / 100, 1)}`).join(", ")}>
          {dist.map((s) => (
            <span key={s.key} className={cx("h-full", s.className)} style={{ width: `${s.pct}%` }} />
          ))}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-12 text-ink-2">
          {dist.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span className={cx("h-2 w-2 rounded-[2px]", s.className)} aria-hidden />
              {s.label} <span className="num text-ink-3">{formatPct(s.pct / 100, 1)}</span>
            </li>
          ))}
        </ul>
      </div>
      <Table columns={columns} rows={rows} rowKey={(r) => r.address} maxHeight={520} dense caption={`Top holders of $${app.ticker}`} />
      <p className="num text-12 text-ink-3">
        {rows.length} of {app.holders.toLocaleString("en-US")} holders · supply {formatTokenUnits(data.supplyUnits)}
      </p>
    </div>
  );
};
