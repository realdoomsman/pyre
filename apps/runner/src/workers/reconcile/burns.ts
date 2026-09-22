import { big, prisma } from "@pyre/db";
import { getTokenInfo } from "@pyre/chain";
import type { WorkerContext } from "../../lib/queues.js";
import { chainWorkerEnv } from "../chain/env.js";
import { emptyOutcome, type CheckOutcome } from "./report.js";

/** A $PYRE burn parked in SWAPPING/SWAPPED past this is an operator problem, not a retry in progress. */
const PYRE_STUCK_AFTER_MS = 30 * 60_000;

/**
 * BURNS: what the database says was burned must be visible on chain. `Σ PyreBurn.burnedUnits`
 * (each a `totalSupply()` delta observed across `token.burn()`) is compared with
 * `launchSupply − totalSupply + balance(dead)`: the on-chain figure can exceed the ledger (anyone
 * may burn), but the ledger can never exceed the chain. Rows stuck between buy and burn are
 * reported too, since bought $PYRE sitting in the treasury is indistinguishable from staked
 * custody. Reports only.
 */
export const checkBurns = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const log = ctx.log.child({ worker: "reconcile", check: "BURNS" });
  const token = chainWorkerEnv().PYRE_TOKEN;
  if (!token) return outcome;
  const [settled, stuck] = await Promise.all([
    prisma.pyreBurn.aggregate({ where: { status: "BURNED" }, _sum: { burnedUnits: true, tokensBurned: true }, _count: true }),
    prisma.pyreBurn.findMany({
      where: { status: { in: ["SWAPPING", "SWAPPED"] }, createdAt: { lt: new Date(Date.now() - PYRE_STUCK_AFTER_MS) } },
      select: { id: true, status: true, swapTx: true, error: true, createdAt: true },
    }),
  ]);
  outcome.checked = settled._count + stuck.length;
  for (const row of stuck) {
    outcome.drifted++;
    outcome.findings.push({
      code: "PYRE_BURN_STUCK",
      detail: `PyreBurn ${row.id} has been ${row.status} since ${row.createdAt.toISOString()} (swap ${row.swapTx ?? "unknown"}): ${row.error ?? "no error recorded"}`,
      pyreBurnId: row.id,
    });
  }
  if (settled._count === 0) return outcome;
  const burnedUnits = big(settled._sum.burnedUnits);
  const tokensBurned = big(settled._sum.tokensBurned);
  let onChain: bigint;
  try {
    onChain = (await getTokenInfo(token)).burnedUnits;
  } catch (err) {
    outcome.ok = false;
    outcome.findings.push({ code: "BURN_SUPPLY_UNREADABLE", detail: `$PYRE token reads failed for ${token}: ${err instanceof Error ? err.message : String(err)}` });
    log.warn({ err, token }, "$PYRE supply unreadable");
    return outcome;
  }
  if (burnedUnits > onChain) {
    outcome.drifted++;
    outcome.findings.push({
      code: "PYRE_BURNS_EXCEED_CHAIN",
      detail: `PyreBurn.burnedUnits total ${burnedUnits.toString()} over ${settled._count} burns exceeds on-chain burned supply ${onChain.toString()}`,
      ledgerUnits: burnedUnits.toString(),
      chainUnits: onChain.toString(),
    });
    log.warn({ ledger: burnedUnits.toString(), chain: onChain.toString() }, "recorded $PYRE burns exceed on-chain supply delta");
  }
  if (tokensBurned !== burnedUnits) {
    outcome.drifted++;
    outcome.findings.push({ code: "PYRE_BURN_PROOF_MISMATCH", detail: `tokensBurned ${tokensBurned.toString()} sent to burn() vs totalSupply delta ${burnedUnits.toString()} observed` });
  }
  return outcome;
};
