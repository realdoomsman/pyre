import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PositionDto } from "@pyre/shared";
import { useReducedMotion } from "../../lib/motion.js";
import { formatPriceUsd, formatTokenUnits, formatUsd } from "../../lib/format.js";
import { Avatar, Button, EmptyState, Table, TickFlash, cx, type Column } from "../../ui/index.js";

/**
 * Share of supply as a ring. A mono `+0.0012%` tick marks each step up — the only
 * celebratory motion in the product, tied to a real on-chain fill.
 */
const ShareRing = ({ pct }: { pct: number }) => {
  const reduced = useReducedMotion();
  const prev = useRef(pct);
  const [tick, setTick] = useState<{ key: number; delta: number } | null>(null);

  useEffect(() => {
    const delta = pct - prev.current;
    prev.current = pct;
    if (delta <= 0) return;
    setTick({ key: Date.now(), delta });
    const t = window.setTimeout(() => setTick(null), 2400);
    return () => window.clearTimeout(t);
  }, [pct]);

  const size = 28;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // A holder's share is a sliver; the ring shows it against 1% so growth is visible.
  const fill = Math.min(1, pct / 1);

  return (
    <span className="relative inline-flex items-center gap-2">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" role="img" aria-label={`${pct.toFixed(4)}% of supply`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fill)}
          className={cx("text-accent transition-[stroke-dashoffset] duration-(--duration-reveal) ease-(--ease-reveal)", tick && !reduced && "animate-cool")}
        />
      </svg>
      <span className="num text-13 text-ink">{pct.toFixed(4)}%</span>
      {tick && (
        <span key={tick.key} className={cx("num absolute -top-3 right-0 text-12 text-earn", !reduced && "animate-rise")} aria-live="polite">
          +{tick.delta.toFixed(4)}%
        </span>
      )}
    </span>
  );
};

export const Positions = ({ positions }: { positions: PositionDto[] }) => {
  const navigate = useNavigate();

  if (positions.length === 0) {
    return (
      <EmptyState
        title="No positions"
        body="Buy a coin from its page and it appears here."
        action={
          <Button variant="secondary" size="sm" onClick={() => navigate("/")}>
            Browse coins
          </Button>
        }
      />
    );
  }

  const columns: Column<PositionDto>[] = [
    {
      key: "coin",
      header: "Coin",
      render: (p) => (
        <span className="flex items-center gap-2.5">
          <Avatar src={p.app.imageUrl} name={p.app.ticker} size={28} shape="square" />
          <span className="min-w-0">
            <span className="block truncate text-14 font-medium text-ink">{p.app.name}</span>
            <span className="num block text-12 text-ink-3">${p.app.ticker}</span>
          </span>
        </span>
      ),
    },
    { key: "units", header: "Balance", numeric: true, collapse: true, render: (p) => formatTokenUnits(p.units, { compact: true }) },
    { key: "price", header: "Price", numeric: true, collapse: true, render: (p) => formatPriceUsd(p.app.priceUsd) },
    {
      key: "value",
      header: "Value",
      numeric: true,
      render: (p) => (
        <TickFlash value={p.valueUsd}>
          <span className="text-ink">{formatUsd(BigInt(Math.round(p.valueUsd * 1e6)))}</span>
        </TickFlash>
      ),
    },
    { key: "share", header: "Share of supply", numeric: true, render: (p) => <ShareRing pct={p.shareOfRemainingPct} /> },
  ];

  return <Table columns={columns} rows={positions} rowKey={(p) => p.app.id} onRowClick={(p) => navigate(`/c/${p.app.slug}`)} caption="Your coin positions" />;
};
