import { prisma } from "@pyre/db";
import type { WorkerContext } from "../../lib/queues.js";
import { emptyOutcome, type CheckOutcome } from "./report.js";

/**
 * Everything here is exact bigint arithmetic, so the only legitimate difference is
 * a rounding tail. A tenth of a cent is generous and still catches real drift.
 */
const TOLERANCE_MICROS = 1_000n;

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const usd = (micros: bigint): string => `$${(Number(micros) / 1e6).toFixed(6)}`;

/**
 * LEDGER: asserts the money invariants and reports what it finds. It never
 * "fixes" anything — an automatic correction to a money column would destroy the
 * evidence an operator needs.
 */
export const checkLedger = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const apps = await prisma.app.findMany({
    select: { id: true, slug: true, budgetMicros: true, spentMicros: true, revenueMicros: true, pendingRevenueMicros: true },
  });
  outcome.checked = apps.length;

  const buildLedger = await prisma.ledgerEntry.groupBy({
    by: ["account"],
    where: { account: { startsWith: "BUILD:" } },
    _sum: { deltaMicros: true },
  });
  const ledgerByApp: Record<string, bigint> = {};
  for (const row of buildLedger) ledgerByApp[row.account.slice("BUILD:".length)] = row._sum.deltaMicros ?? 0n;

  const buybacks = await prisma.buyback.groupBy({
    by: ["appId"],
    where: { status: { not: "FAILED" } },
    _sum: { revenueMicros: true },
  });
  const buybackByApp: Record<string, bigint> = {};
  for (const row of buybacks) buybackByApp[row.appId] = row._sum.revenueMicros ?? 0n;

  const unattested = await prisma.revenueEvent.groupBy({ by: ["appId"], where: { buybackId: null }, _sum: { usdMicros: true } });
  const unattestedByApp: Record<string, bigint> = {};
  for (const row of unattested) unattestedByApp[row.appId] = row._sum.usdMicros ?? 0n;

  for (const app of apps) {
    const ledgerSum = ledgerByApp[app.id] ?? 0n;
    // Credits are positive, agent spend negative, so the account balance is the unspent
    // budget. `debitAppBudget` floors `budgetMicros` at 0, so an exhausted app may sit at
    // 0 with a negative ledger tail; only a ledger balance ABOVE the column is drift there.
    const budgetDrift = app.budgetMicros === 0n ? (ledgerSum > TOLERANCE_MICROS ? ledgerSum : 0n) : ledgerSum - app.budgetMicros;
    if (abs(budgetDrift) > TOLERANCE_MICROS) {
      outcome.drifted++;
      outcome.findings.push({
        code: "BUILD_LEDGER_DRIFT",
        detail: `BUILD:${app.id} ledger balance ${usd(ledgerSum)} vs App.budgetMicros ${usd(app.budgetMicros)} (spent ${usd(app.spentMicros)}): drift ${usd(budgetDrift)}`,
        appId: app.id,
        slug: app.slug,
        ledgerMicros: ledgerSum.toString(),
        budgetMicros: app.budgetMicros.toString(),
        spentMicros: app.spentMicros.toString(),
      });
    }

    const attested = buybackByApp[app.id] ?? 0n;
    if (attested > app.revenueMicros + TOLERANCE_MICROS) {
      outcome.drifted++;
      outcome.findings.push({
        code: "BUYBACK_EXCEEDS_REVENUE",
        detail: `buybacks attested ${usd(attested)} exceed lifetime revenue ${usd(app.revenueMicros)}`,
        appId: app.id,
        slug: app.slug,
      });
    }

    const pending = unattestedByApp[app.id] ?? 0n;
    if (abs(pending - app.pendingRevenueMicros) > TOLERANCE_MICROS) {
      outcome.drifted++;
      outcome.findings.push({
        code: "PENDING_REVENUE_DRIFT",
        detail: `unattested RevenueEvent total ${usd(pending)} vs App.pendingRevenueMicros ${usd(app.pendingRevenueMicros)}`,
        appId: app.id,
        slug: app.slug,
        unattestedMicros: pending.toString(),
        pendingRevenueMicros: app.pendingRevenueMicros.toString(),
      });
    }
  }

  // Fee split: every collected dollar must land in exactly one bucket. The staker
  // share has no column on FeeEvent — it lives on the STAKERS:<appId> ledger account.
  const fees = await prisma.feeEvent.aggregate({
    _sum: { usdMicros: true, buildMicros: true, creditsMicros: true, pyreMicros: true, launcherMicros: true, upstreamMicros: true },
    _count: true,
  });
  const stakerLedger = await prisma.ledgerEntry.aggregate({
    where: { account: { startsWith: "STAKERS:" }, refType: "FeeEvent" },
    _sum: { deltaMicros: true },
  });
  const feeTotal = fees._sum.usdMicros ?? 0n;
  const parts =
    (fees._sum.buildMicros ?? 0n) +
    (fees._sum.creditsMicros ?? 0n) +
    (fees._sum.pyreMicros ?? 0n) +
    (fees._sum.launcherMicros ?? 0n) +
    (fees._sum.upstreamMicros ?? 0n) +
    (stakerLedger._sum.deltaMicros ?? 0n);
  outcome.checked += fees._count;
  if (abs(parts - feeTotal) > TOLERANCE_MICROS) {
    outcome.drifted++;
    outcome.findings.push({
      code: "FEE_SPLIT_DRIFT",
      detail: `fee split parts ${usd(parts)} (build+credits+ship+launcher+upstream+stakers) vs collected ${usd(feeTotal)} over ${fees._count} FeeEvent rows`,
      partsMicros: parts.toString(),
      usdMicros: feeTotal.toString(),
    });
  }
  if (outcome.drifted > 0) ctx.log.warn({ worker: "reconcile", check: "LEDGER", drifted: outcome.drifted }, "ledger invariants drifted");
  return outcome;
};
