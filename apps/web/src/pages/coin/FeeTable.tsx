import { useMemo } from "react";
import type { AppDetailDto } from "@pyre/shared";
import { formatEth, formatPct, formatUsd } from "../../lib/format.js";
import { Card, CardHeader, Table, cx, type Column } from "../../ui/index.js";

interface FeeRow {
  key: string;
  label: string;
  share: number;
  /** ETH-denominated share of everything claimed so far. */
  wei: bigint;
  /** USD actually booked, summed over the fee-event history. */
  micros: bigint;
  tone?: "build" | "accent" | "earn";
}

const toneClass = (tone?: string) => (tone === "build" ? "text-build" : tone === "accent" ? "text-accent" : tone === "earn" ? "text-earn" : "text-ink");

/**
 * Where every wei goes. Creator fees split 60 / 25 / 15 to the agent, $PYRE
 * buy-and-burn and the launcher. Accrued = claimed and booked; accruing =
 * still on the curve, hook or escrow, not yet split.
 */
export const FeeTable = ({ app }: { app: AppDetailDto }) => {
  const feesWei = BigInt(app.feesWei);
  const booked = useMemo(() => {
    let build = 0n;
    let pyre = 0n;
    let launcher = 0n;
    for (const f of app.budgetHistory) {
      build += BigInt(f.buildMicros);
      pyre += BigInt(f.pyreMicros);
      launcher += BigInt(f.launcherMicros);
    }
    return { build, pyre, launcher };
  }, [app.budgetHistory]);

  const feeRows: FeeRow[] = [
    { key: "agent", label: "Agent budget", share: app.feeSplit.buildBudget, wei: (feesWei * BigInt(app.feeSplit.buildBudget)) / 10_000n, micros: booked.build, tone: "build" },
    { key: "pyre", label: "PYRE buy-and-burn", share: app.feeSplit.pyreToken, wei: (feesWei * BigInt(app.feeSplit.pyreToken)) / 10_000n, micros: booked.pyre, tone: "accent" },
    { key: "launcher", label: "Launcher", share: app.feeSplit.launcher, wei: (feesWei * BigInt(app.feeSplit.launcher)) / 10_000n, micros: booked.launcher, tone: "earn" },
  ];

  const feeCols: Column<FeeRow>[] = [
    { key: "label", header: "Creator fees", render: (r) => <span className={cx("font-medium", toneClass(r.tone))}>{r.label}</span> },
    { key: "share", header: "Share", numeric: true, render: (r) => formatPct(r.share / 10_000, 0) },
    { key: "wei", header: "Accrued", numeric: true, render: (r) => formatEth(r.wei) },
    { key: "usd", header: "Booked", numeric: true, collapse: true, render: (r) => formatUsd(r.micros) },
  ];

  return (
    <Card as="section" padding={0} aria-label="Fee transparency">
      <CardHeader
        eyebrow="Fee transparency"
        title={`${formatEth(feesWei)} claimed`}
        description={`${formatEth(BigInt(app.unsweptWei) + BigInt(app.escrowWei))} still accruing on the curve and in escrow · creator tax 0%`}
        className="mb-0 px-4 pt-4 sm:px-5 sm:pt-5"
      />
      <Table columns={feeCols} rows={feeRows} rowKey={(r) => r.key} dense className="mt-3" caption="Creator fee split" />
      <p className="small px-4 py-3 text-ink-3 sm:px-5">
        PONS charges 1% on every fill; 70% of that plus 100% of any creator tax reaches this app’s wallet and is swept to escrow. Pyre claims it, converts at the ETH price of the moment, and books the split above.
      </p>
    </Card>
  );
};
