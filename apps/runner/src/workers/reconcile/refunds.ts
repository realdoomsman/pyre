import { prisma } from "@pyre/db";
import { REFUND_LEDGER_ACCOUNT } from "@pyre/shared";
import type { WorkerContext } from "../../lib/queues.js";
import { chainWorkerEnv } from "../chain/env.js";
import { REFUND_FEE_ROUTE_KEY, feesNotRouted, type PyreSolFeeRoute } from "../chain/feeSweep.js";
import { emptyOutcome, type CheckOutcome } from "./report.js";

/** A PENDING refund payout older than this was interrupted mid-send (crash or transport error). */
const STALE_PENDING_MS = 60 * 60_000;

/**
 * REFUNDS: the refund program's money invariants. Read-only, like LEDGER:
 *   pool = Σ REFUND credits − Σ REFUND debits ≥ 0 (credits: `PlatformFee` from the Solana PYRE
 *   coin's creator fees and `FeeEvent` from the legacy Robinhood Chain coins' 25% PYRE leg)
 *   Σ RefundAllocation debits = Σ(holder.creditMicros + holder.paidMicros) + Σ PENDING/SENT payout usdMicros
 *   settledWei ≤ owedWei for every holder; minBalanceUnits ≤ min(balanceUnits, currentBalanceUnits)
 *   (holding only ever lowers it); no PENDING payout left behind; and the Solana PYRE coin's
 *   creator fees, as the last fee sweep saw them, actually reach the treasury.
 * All terms are exact bigint sums, so any difference at all is drift.
 */
export const checkRefunds = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const [pool, allocated, holders, inFlight, overSettled, badHolding, stalePending, feeRoute] = await Promise.all([
    prisma.ledgerEntry.aggregate({ where: { account: REFUND_LEDGER_ACCOUNT }, _sum: { deltaMicros: true }, _count: true }),
    prisma.ledgerEntry.aggregate({ where: { account: REFUND_LEDGER_ACCOUNT, refType: "RefundAllocation" }, _sum: { deltaMicros: true } }),
    prisma.refundHolder.aggregate({ _sum: { creditMicros: true, paidMicros: true }, _count: true }),
    prisma.refundPayout.aggregate({ where: { status: { in: ["PENDING", "SENT"] } }, _sum: { usdMicros: true } }),
    prisma.refundHolder.findMany({ where: { settledWei: { gt: prisma.refundHolder.fields.owedWei } }, select: { address: true } }),
    prisma.refundHolder.findMany({
      where: { OR: [{ minBalanceUnits: { gt: prisma.refundHolder.fields.balanceUnits } }, { minBalanceUnits: { gt: prisma.refundHolder.fields.currentBalanceUnits } }] },
      select: { address: true, balanceUnits: true, currentBalanceUnits: true, minBalanceUnits: true },
    }),
    // SENT rows normally resolve within minutes of their blockhash expiring; one still SENT after an hour has no provable outcome (processed-only status, or no recorded lastValidBlockHeight).
    prisma.refundPayout.findMany({ where: { status: { in: ["PENDING", "SENT"] }, createdAt: { lt: new Date(Date.now() - STALE_PENDING_MS) } }, select: { id: true, address: true, usdMicros: true, error: true, status: true, txSig: true } }),
    prisma.platformSetting.findUnique({ where: { key: REFUND_FEE_ROUTE_KEY } }),
  ]);
  outcome.checked = pool._count + holders._count;

  const balance = pool._sum.deltaMicros ?? 0n;
  if (balance < 0n) {
    outcome.drifted++;
    outcome.findings.push({ code: "REFUND_POOL_NEGATIVE", detail: `REFUND ledger balance ${balance} micros is below zero`, poolMicros: balance.toString() });
  }
  const debited = -(allocated._sum.deltaMicros ?? 0n);
  const accounted = (holders._sum.creditMicros ?? 0n) + (holders._sum.paidMicros ?? 0n) + (inFlight._sum.usdMicros ?? 0n);
  if (debited !== accounted) {
    outcome.drifted++;
    outcome.findings.push({
      code: "REFUND_ALLOCATION_DRIFT",
      detail: `REFUND allocation debits ${debited} micros vs holder credit + paid + in-flight payouts ${accounted} micros`,
      allocatedMicros: debited.toString(),
      accountedMicros: accounted.toString(),
    });
  }
  for (const h of overSettled) {
    outcome.drifted++;
    outcome.findings.push({ code: "REFUND_OVER_SETTLED", detail: `RefundHolder ${h.address} settledWei exceeds owedWei`, address: h.address });
  }
  for (const h of badHolding) {
    outcome.drifted++;
    outcome.findings.push({
      code: "REFUND_HOLDING_DRIFT",
      detail: `RefundHolder ${h.address} minBalanceUnits ${h.minBalanceUnits} exceeds its snapshot (${h.balanceUnits}) or current (${h.currentBalanceUnits}) balance`,
      address: h.address,
    });
  }
  for (const p of stalePending) {
    outcome.drifted++;
    outcome.findings.push(
      p.status === "SENT"
        ? {
            code: "REFUND_PAYOUT_STUCK_SENT",
            detail: `RefundPayout ${p.id} for ${p.address} (${p.usdMicros} micros) has been SENT over an hour without a provable outcome; look up ${p.txSig} before restoring or confirming it`,
            payoutId: p.id,
            address: p.address,
            txSig: p.txSig,
          }
        : {
            code: "REFUND_PAYOUT_STUCK_PENDING",
            detail: `RefundPayout ${p.id} for ${p.address} (${p.usdMicros} micros) has been PENDING over an hour; check the treasury Solana wallet history before restoring or confirming it`,
            payoutId: p.id,
            address: p.address,
            error: p.error,
          },
    );
  }
  const route = feeRoute?.value as PyreSolFeeRoute | undefined;
  // A route recorded for an earlier mint is stale: the sweep only looks at the configured one.
  if (route && route.mint === chainWorkerEnv().PYRE_SOL_MINT && feesNotRouted(route)) {
    outcome.drifted++;
    const to =
      route.route === "foreign"
        ? `creator ${route.creator}`
        : `fee-sharing config ${route.creator} shareholders ${(route.shareholders ?? []).map((s) => `${s.address} (${s.shareBps} bps)`).join(", ")}`;
    outcome.findings.push({
      code: "REFUND_FEES_NOT_ROUTED",
      detail: `Solana PYRE ${route.mint} creator fees go to ${to}, not the treasury ${route.treasury}; nothing reaches the REFUND pool (seen ${route.checkedAt})`,
      mint: route.mint,
      route: route.route,
      creator: route.creator,
      shareholders: route.shareholders,
    });
  }
  if (outcome.drifted > 0) ctx.log.warn({ worker: "reconcile", check: "REFUNDS", drifted: outcome.drifted }, "refund invariants drifted");
  return outcome;
};
