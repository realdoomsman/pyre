import { useMemo, type ReactNode } from "react";
import type { AppDetailDto } from "@pyre/shared";
import { venueOf } from "@pyre/shared";
import { formatNative, formatPct, formatTokenUnits, formatUsd, timeAgo } from "../../lib/format.js";
import { useVenueLinks } from "../../lib/venue.js";
import { Address, Card, CardHeader, NativeFlow, TickFlash, UsdFlow, cx } from "../../ui/index.js";
import { agentChip } from "./CoinHeader.js";

/*
 * The loop, as four live numbers: Fees accrued → Agent budget → Build state →
 * the burn leg. On Robinhood Chain the 25% share buys and burns PYRE; on
 * Solana it buys and burns the coin itself (PYRE stays on Robinhood Chain).
 * Each cell shows the number, the next thing that will happen to it, and
 * when it last moved.
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

export const LoopStatus = ({ app }: { app: AppDetailDto }) => {
  const venue = venueOf(app);
  const links = useVenueLinks(app);
  const native = venue.native;
  const feesWei = BigInt(app.feesWei);
  const unswept = BigInt(app.unsweptWei);
  const escrow = BigInt(app.escrowWei);
  const lastFee = app.budgetHistory[0]?.createdAt ?? null;
  const build = app.lastBuild;
  // This coin's 25% share of every fee claim, booked in USD at claim time; it funds the buy-and-burn.
  const burnMicros = useMemo(() => app.budgetHistory.reduce((s, f) => s + BigInt(f.pyreMicros) + BigInt(f.coinBurnMicros), 0n), [app.budgetHistory]);
  const burnBps = app.feeSplit.pyreToken + app.feeSplit.coinBurn;
  const burnWei = (feesWei * BigInt(burnBps)) / 10_000n;
  const coinBurns = app.coinBurns;
  const burnCell: Cell = coinBurns
    ? {
        key: "burn",
        label: `$${app.ticker} burned`,
        value: <span className="text-burn">{formatTokenUnits(coinBurns.burnedUnits, { decimals: venue.tokenDecimals })}</span>,
        tick: coinBurns.burnedUnits,
        sub: (
          <>
            {formatPct(coinBurns.burnedPctOfSupply / 100, 3)} of supply · {formatNative(coinBurns.nativeWei, native)} over {coinBurns.count} burns
            {coinBurns.last ? (
              <span className="text-ink-3">
                {" "}
                · last{" "}
                {coinBurns.last.burnTx ? <Address address={coinBurns.last.burnTx} kind="tx" chars={3} explorerUrl={links.tx(coinBurns.last.burnTx)} copy={false} /> : "pending"}
                {coinBurns.last.attestTx && (
                  <>
                    {" "}
                    · attested <Address address={coinBurns.last.attestTx} kind="tx" chars={3} explorerUrl={links.tx(coinBurns.last.attestTx)} copy={false} />
                  </>
                )}
              </span>
            ) : (
              <span className="text-ink-3"> · {formatUsd(coinBurns.pendingMicros)} pending, burns at $5</span>
            )}
          </>
        ),
        updatedAt: coinBurns.last?.createdAt ?? lastFee,
        tone: "burn",
      }
    : {
        key: "pyre",
        label: "PYRE share burned",
        value: <UsdFlow micros={burnMicros} />,
        tick: burnMicros,
        sub: (
          <>
            {formatNative(burnWei, native)} <span className="text-ink-3">· {formatPct(burnBps / 10_000, 0)} of every fee claim buys and burns PYRE</span>
          </>
        ),
        updatedAt: lastFee,
        tone: "burn",
      };
  const cells: Cell[] = [
    {
      key: "fees",
      label: "Fees accrued",
      value: <NativeFlow units={feesWei} native={native} digits={4} />,
      tick: feesWei,
      sub: (
        <>
          <span className="text-ink-2">accruing</span> {formatNative(unswept + escrow, native)}{" "}
          <span className="text-ink-3">
            {venue.chain === "solana" ? `· creator vault ${formatNative(unswept, native)}` : `· unswept ${formatNative(unswept, native)} · escrow ${formatNative(escrow, native)}`}
          </span>
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
    burnCell,
  ];

  return (
    <Card as="section" padding="md" aria-label="Loop status">
      <CardHeader eyebrow="The loop" title={coinBurns ? `Fees → agent → app → $${app.ticker} burn` : "Fees → agent → app → PYRE burn"} />
      <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
