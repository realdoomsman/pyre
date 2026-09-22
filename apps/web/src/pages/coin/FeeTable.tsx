import { useMemo } from "react";
import type { AppDetailDto } from "@pyre/shared";
import { venueOf } from "@pyre/shared";
import { formatNative, formatPct, formatUsd } from "../../lib/format.js";
import { Card, CardHeader, Table, cx, type Column } from "../../ui/index.js";

interface FeeRow {
  key: string;
  label: string;
  share: number;
  /** Native-denominated share of everything claimed so far. */
  units: bigint;
  /** USD actually booked, summed over the fee-event history. */
  micros: bigint;
  tone?: "build" | "accent" | "earn";
}

const toneClass = (tone?: string) => (tone === "build" ? "text-build" : tone === "accent" ? "text-accent" : tone === "earn" ? "text-earn" : "text-ink");

/**
 * Where every unit goes. Creator fees split 60 / 25 / 15 to the agent, the burn leg (PYRE on
 * Robinhood Chain, the coin itself on Solana) and the launcher. Accrued = claimed and booked;
 * accruing = still on the curve, hook, vault or escrow, not yet split.
 */
export const FeeTable = ({ app }: { app: AppDetailDto }) => {
  const venue = venueOf(app);
  const native = venue.native;
  const solana = venue.chain === "solana";
  const feesWei = BigInt(app.feesWei);
  const booked = useMemo(() => {
    let build = 0n;
    let burn = 0n;
    let launcher = 0n;
    for (const f of app.budgetHistory) {
      build += BigInt(f.buildMicros);
      burn += BigInt(f.pyreMicros) + BigInt(f.coinBurnMicros);
      launcher += BigInt(f.launcherMicros);
    }
    return { build, burn, launcher };
  }, [app.budgetHistory]);
  const burnBps = app.feeSplit.pyreToken + app.feeSplit.coinBurn;

  const feeRows: FeeRow[] = [
    { key: "agent", label: "Agent budget", share: app.feeSplit.buildBudget, units: (feesWei * BigInt(app.feeSplit.buildBudget)) / 10_000n, micros: booked.build, tone: "build" },
    { key: "burn", label: solana ? `$${app.ticker} buy-and-burn` : "PYRE buy-and-burn", share: burnBps, units: (feesWei * BigInt(burnBps)) / 10_000n, micros: booked.burn, tone: "accent" },
    { key: "launcher", label: "Launcher", share: app.feeSplit.launcher, units: (feesWei * BigInt(app.feeSplit.launcher)) / 10_000n, micros: booked.launcher, tone: "earn" },
  ];

  const feeCols: Column<FeeRow>[] = [
    { key: "label", header: "Creator fees", render: (r) => <span className={cx("font-medium", toneClass(r.tone))}>{r.label}</span> },
    { key: "share", header: "Share", numeric: true, render: (r) => formatPct(r.share / 10_000, 0) },
    { key: "units", header: "Accrued", numeric: true, render: (r) => formatNative(r.units, native) },
    { key: "usd", header: "Booked", numeric: true, collapse: true, render: (r) => formatUsd(r.micros) },
  ];

  return (
    <Card as="section" padding={0} aria-label="Fee transparency">
      <CardHeader
        eyebrow="Fee transparency"
        title={`${formatNative(feesWei, native)} claimed`}
        description={`${formatNative(BigInt(app.unsweptWei) + BigInt(app.escrowWei), native)} still accruing ${solana ? "in the creator vault" : "on the curve and in escrow"} · creator tax 0%`}
        className="mb-0 px-4 pt-4 sm:px-5 sm:pt-5"
      />
      <Table columns={feeCols} rows={feeRows} rowKey={(r) => r.key} dense className="mt-3" caption="Creator fee split" />
      <p className="small px-4 py-3 text-ink-3 sm:px-5">
        {solana
          ? "pump.fun pays this app’s wallet a creator fee on every trade — 0.30% on the curve, a tiered share on the PumpSwap pool; the rates are pump.fun’s and can change. Pyre claims the vault, converts at the SOL price of the moment, and books the split above."
          : "pons charges 1% on every fill; 70% of that plus 100% of any creator tax reaches this app’s wallet and is swept to escrow. Pyre claims it, converts at the ETH price of the moment, and books the split above."}
      </p>
    </Card>
  );
};
