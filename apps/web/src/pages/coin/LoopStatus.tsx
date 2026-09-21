import type { ReactNode } from "react";
import type { AppDetailDto } from "@pyre/shared";
import { formatEth, formatPct, formatTokenUnits, formatUsd, timeAgo } from "../../lib/format.js";
import { Card, CardHeader, EthFlow, NumberFlow, TickFlash, UsdFlow, cx } from "../../ui/index.js";
import { agentChip } from "./CoinHeader.js";

/*
 * The loop, as six live numbers: Fees accrued → Agent budget → Build state →
 * App revenue → Buyback pending → Burned. Each cell shows the number, the
 * next thing that will happen to it, and when it last moved.
 */

interface Cell {
  key: string;
  label: string;
  value: ReactNode;
  /** The watched primitive: a change flashes the cell. */
  tick: number | bigint | string;
  sub: ReactNode;
  updatedAt: string | null;
  tone?: "earn" | "build" | "burn";
}

export const LoopStatus = ({ app, updatedAt }: { app: AppDetailDto; updatedAt: number }) => {
  const feesWei = BigInt(app.feesWei);
  const unswept = BigInt(app.unsweptWei);
  const escrow = BigInt(app.escrowWei);
  const pending = BigInt(app.pendingRevenueMicros);
  const lastFee = app.budgetHistory[0]?.createdAt ?? null;
  const build = app.lastBuild;
  const buyback = app.lastBuyback;
  const buybackThreshold = 5_000_000n; // $5 in micros — the runner's buyback trigger
  const cells: Cell[] = [
    {
      key: "fees",
      label: "Fees accrued",
      value: <EthFlow wei={feesWei} digits={4} />,
      tick: feesWei,
      sub: (
        <>
          <span className="text-ink-2">accruing</span> {formatEth(unswept + escrow)} <span className="text-ink-3">· unswept {formatEth(unswept)} · escrow {formatEth(escrow)}</span>
        </>
      ),
      updatedAt: lastFee,
      tone: "earn",
    },
    {
      key: "budget",
      label: "Agent budget",
      value: <UsdFlow micros={BigInt(app.budgetMicros)} />,
      tick: app.budgetMicros,
      sub: (
        <>
          spent {formatUsd(app.spentMicros)} <span className="text-ink-3">· {formatPct(app.feeSplit.buildBudget / 10_000, 0)} of every fee claim</span>
        </>
      ),
      updatedAt: lastFee,
      tone: "build",
    },
    {
      key: "build",
      label: "Build state",
      value: <span className="inline-flex h-[1em] items-center">{agentChip(app.agentState)}</span>,
      tick: `${app.agentState}:${build?.id ?? ""}:${build?.status ?? ""}`,
      sub: build ? (
        <>
          {build.stage.toLowerCase()} · {build.status.toLowerCase()}
          {build.model && <span className="text-ink-3"> · {build.model}</span>}
          {app.liveVersion > 0 && <span className="text-ink-3"> · live v{app.liveVersion}</span>}
        </>
      ) : (
        <span className="text-ink-3">no build yet</span>
      ),
      updatedAt: build?.finishedAt ?? build?.startedAt ?? build?.createdAt ?? null,
      tone: "build",
    },
    {
      key: "revenue",
      label: "App revenue",
      value: <UsdFlow micros={BigInt(app.revenueMicros)} />,
      tick: app.revenueMicros,
      sub: (
        <>
          {formatUsd(app.revenue24hMicros)} <span className="text-ink-3">last 24h · {app.usersCount.toLocaleString("en-US")} users</span>
        </>
      ),
      updatedAt: new Date(updatedAt).toISOString(),
      tone: "earn",
    },
    {
      key: "buyback",
      label: "Buyback pending",
      value: <UsdFlow micros={pending} />,
      tick: pending,
      sub:
        pending >= buybackThreshold ? (
          <span className="text-earn">above the $5 trigger · next pass buys and burns</span>
        ) : (
          <>
            <span className="text-ink-3">fires at $5 ·</span> {formatPct(app.revenueSplit.buybackBurn / 10_000, 0)} of revenue
          </>
        ),
      updatedAt: buyback?.createdAt ?? null,
      tone: "burn",
    },
    {
      key: "burned",
      label: "Burned",
      value: <NumberFlow value={app.burnedPct} format={{ minimumFractionDigits: 3, maximumFractionDigits: 3 }} suffix="%" />,
      tick: app.burnedUnits,
      sub: (
        <>
          {formatTokenUnits(app.burnedUnits)} tokens <span className="text-ink-3">· {formatEth(app.buybackWei)} bought back</span>
        </>
      ),
      updatedAt: buyback?.completedAt ?? null,
      tone: "burn",
    },
  ];

  return (
    <Card as="section" padding="md" aria-label="Loop status">
      <CardHeader eyebrow="The loop" title="Fees → agent → app → revenue → buyback → burn" />
      <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {cells.map((c, i) => (
          <li key={c.key} className="min-w-0">
            <TickFlash value={c.tick} as="div" className="rounded-control border border-line bg-canvas/40 p-3">
              <div className="flex items-center gap-2">
                <span className={cx("h-1.5 w-1.5 rounded-pill", c.tone === "earn" ? "bg-earn" : c.tone === "build" ? "bg-build" : "bg-burn")} aria-hidden />
                <span className="eyebrow">
                  <span className="text-ink-3">{i + 1} · </span>
                  {c.label}
                </span>
              </div>
              <div className="num mt-1.5 text-18 font-medium text-ink">{c.value}</div>
              <div className="num mt-1 truncate text-12 leading-4 text-ink-2">{c.sub}</div>
              <div className="num mt-1 text-12 text-ink-3">{c.updatedAt ? `updated ${timeAgo(c.updatedAt)}` : "—"}</div>
            </TickFlash>
          </li>
        ))}
      </ol>
    </Card>
  );
};
