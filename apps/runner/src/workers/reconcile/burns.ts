import { big, prisma } from "@pyre/db";
import { getTokenInfo } from "@pyre/chain";
import type { Address } from "viem";
import type { WorkerContext } from "../../lib/queues.js";
import { emptyOutcome, type CheckOutcome } from "./report.js";

/**
 * BURNS: what the database says was burned must be visible on chain. Per app,
 * `Σ Buyback.burnedUnits` (each a `totalSupply()` delta observed across `token.burn()`) is
 * compared with `launchSupply − totalSupply + balance(dead)`: the on-chain figure can exceed the
 * ledger (anyone may burn), but the ledger can never exceed the chain. Reports only.
 */
export const checkBurns = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const log = ctx.log.child({ worker: "reconcile", check: "BURNS" });
  const apps = await prisma.app.findMany({
    where: { tokenAddress: { not: null }, buybacks: { some: { status: "BURNED" } } },
    select: { id: true, slug: true, tokenAddress: true },
  });
  outcome.checked = apps.length;
  if (apps.length === 0) return outcome;
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
  return outcome;
};
