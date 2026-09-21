import { big, prisma } from "@pyre/db";
import { getTokenInfo } from "@pyre/chain";
import type { Address } from "viem";
import type { WorkerContext } from "../../lib/queues.js";
import { chainWorkerEnv } from "../chain/env.js";
import { emptyOutcome, type CheckOutcome } from "./report.js";

/** A $PYRE burn parked in SWAPPING/SWAPPED past this is an operator problem, not a retry in progress. */
const PYRE_STUCK_AFTER_MS = 30 * 60_000;

/**
 * BURNS: what the database says was burned must be visible on chain. Per app,
 * `Σ Buyback.burnedUnits` (each a `totalSupply()` delta observed across `token.burn()`) is
 * compared with `launchSupply − totalSupply + balance(dead)`: the on-chain figure can exceed the
 * ledger (anyone may burn), but the ledger can never exceed the chain. The $PYRE leg does the
 * same over `PyreBurn` rows and additionally reports rows stuck between buy and burn, since bought
 * $PYRE sitting in the treasury is indistinguishable from staked custody. Reports only.
 */
export const checkBurns = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const log = ctx.log.child({ worker: "reconcile", check: "BURNS" });
  const apps = await prisma.app.findMany({
    where: { tokenAddress: { not: null }, buybacks: { some: { status: "BURNED" } } },
    select: { id: true, slug: true, tokenAddress: true },
  });
  outcome.checked = apps.length;
  if (apps.length === 0) {
    await checkPyreBurns(outcome, log);
    return outcome;
  }
  const sums = await prisma.buyback.groupBy({
    by: ["appId"],
    where: { appId: { in: apps.map((a) => a.id) }, status: "BURNED" },
    _sum: { burnedUnits: true, tokensBurned: true },
    _count: true,
  });
  const byApp: Record<string, { burnedUnits: bigint; tokensBurned: bigint; count: number }> = {};
  for (const row of sums) byApp[row.appId] = { burnedUnits: big(row._sum.burnedUnits), tokensBurned: big(row._sum.tokensBurned), count: row._count };

  for (const app of apps) {
    const ledger = byApp[app.id] ?? { burnedUnits: 0n, tokensBurned: 0n, count: 0 };
    let onChain: bigint;
    try {
      onChain = (await getTokenInfo(app.tokenAddress as Address)).burnedUnits;
    } catch (err) {
      outcome.ok = false;
      outcome.findings.push({
        code: "BURN_SUPPLY_UNREADABLE",
        detail: `token reads failed for ${app.tokenAddress}: ${err instanceof Error ? err.message : String(err)}`,
        appId: app.id,
        slug: app.slug,
      });
      log.warn({ err, appId: app.id }, "token supply unreadable");
      continue;
    }
    if (ledger.burnedUnits > onChain) {
      outcome.drifted++;
      outcome.findings.push({
        code: "BURNS_EXCEED_CHAIN",
        detail: `Buyback.burnedUnits total ${ledger.burnedUnits.toString()} over ${ledger.count} burns exceeds on-chain burned supply ${onChain.toString()}`,
        appId: app.id,
        slug: app.slug,
        ledgerUnits: ledger.burnedUnits.toString(),
        chainUnits: onChain.toString(),
      });
      log.warn({ appId: app.id, ledger: ledger.burnedUnits.toString(), chain: onChain.toString() }, "recorded burns exceed on-chain supply delta");
    }
    if (ledger.tokensBurned !== ledger.burnedUnits) {
      outcome.drifted++;
      outcome.findings.push({
        code: "BURN_PROOF_MISMATCH",
        detail: `tokensBurned ${ledger.tokensBurned.toString()} sent to burn() vs totalSupply delta ${ledger.burnedUnits.toString()} observed`,
        appId: app.id,
        slug: app.slug,
      });
    }
  }
  await checkPyreBurns(outcome, log);
  return outcome;
};

const checkPyreBurns = async (outcome: CheckOutcome, log: WorkerContext["log"]): Promise<void> => {
  const token = chainWorkerEnv().PYRE_TOKEN;
  if (!token) return;
  const [settled, stuck] = await Promise.all([
    prisma.pyreBurn.aggregate({ where: { status: "BURNED" }, _sum: { burnedUnits: true, tokensBurned: true }, _count: true }),
    prisma.pyreBurn.findMany({
      where: { status: { in: ["SWAPPING", "SWAPPED"] }, createdAt: { lt: new Date(Date.now() - PYRE_STUCK_AFTER_MS) } },
      select: { id: true, status: true, swapTx: true, error: true, createdAt: true },
    }),
  ]);
  outcome.checked += settled._count + stuck.length;
  for (const row of stuck) {
    outcome.drifted++;
    outcome.findings.push({
      code: "PYRE_BURN_STUCK",
      detail: `PyreBurn ${row.id} has been ${row.status} since ${row.createdAt.toISOString()} (swap ${row.swapTx ?? "unknown"}): ${row.error ?? "no error recorded"}`,
      pyreBurnId: row.id,
    });
  }
  if (settled._count === 0) return;
  const burnedUnits = big(settled._sum.burnedUnits);
  const tokensBurned = big(settled._sum.tokensBurned);
  let onChain: bigint;
  try {
    onChain = (await getTokenInfo(token)).burnedUnits;
  } catch (err) {
    outcome.ok = false;
    outcome.findings.push({ code: "BURN_SUPPLY_UNREADABLE", detail: `$PYRE token reads failed for ${token}: ${err instanceof Error ? err.message : String(err)}` });
    log.warn({ err, token }, "$PYRE supply unreadable");
    return;
  }
  if (burnedUnits > onChain) {
    outcome.drifted++;
    outcome.findings.push({
      code: "PYRE_BURNS_EXCEED_CHAIN",
      detail: `PyreBurn.burnedUnits total ${burnedUnits.toString()} over ${settled._count} burns exceeds on-chain burned supply ${onChain.toString()}`,
      ledgerUnits: burnedUnits.toString(),
      chainUnits: onChain.toString(),
    });
  }
  if (tokensBurned !== burnedUnits) {
    outcome.drifted++;
    outcome.findings.push({ code: "PYRE_BURN_PROOF_MISMATCH", detail: `tokensBurned ${tokensBurned.toString()} sent to burn() vs totalSupply delta ${burnedUnits.toString()} observed` });
  }
};
