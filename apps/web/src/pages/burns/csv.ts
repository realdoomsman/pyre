import type { BurnLedgerRowDto } from "@pyre/shared";

const cell = (v: string | number | null): string => {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per buyback, raw units so the file reconciles against the chain. */
export const burnsCsv = (rows: ReadonlyArray<BurnLedgerRowDto>): string => {
  const head = ["completed_at", "created_at", "slug", "ticker", "status", "revenue_usd_micros", "eth_wei", "tokens_bought_units", "tokens_burned_units", "burned_pct_of_supply", "swap_tx", "burn_tx", "attest_tx", "attest_hash", "revenue_event_count", "cumulative_eth_wei", "cumulative_revenue_usd_micros"];
  const lines = rows.map((r) =>
    [
      r.completedAt,
      r.createdAt,
      r.slug,
      r.ticker,
      r.status,
      r.revenueMicros,
      r.ethWei,
      r.tokensBoughtUnits,
      r.tokensBurnedUnits,
      r.burnedPctOfSupply,
      r.swapTx,
      r.burnTx,
      r.attestTx,
      r.attestHash,
      r.revenueEventIds,
      r.cumulativeEthWei,
      r.cumulativeRevenueMicros,
    ]
      .map(cell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
};

export const downloadText = (name: string, text: string, type = "text/csv"): void => {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};
