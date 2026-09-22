import { big, prisma } from "@pyre/db";
import { adapterFor, getTokenInfo, solanaEnabled } from "@pyre/chain";
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
  await checkCoinBurns(outcome);
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

/**
 * Coin burns (Solana apps): a row parked between buy and burn past the stuck window is reported,
 * and `Σ burnedUnits` per app can never exceed what the mint's supply says left circulation
 * (`totalSupplyUnits − circulatingUnits` per the adapter; anyone may burn, so chain ≥ ledger).
 */
const checkCoinBurns = async (outcome: CheckOutcome): Promise<void> => {
  const stuck = await prisma.coinBurn.findMany({
    where: { status: { in: ["SWAPPING", "SWAPPED"] }, createdAt: { lt: new Date(Date.now() - PYRE_STUCK_AFTER_MS) } },
    select: { id: true, appId: true, status: true, swapTx: true, error: true, createdAt: true },
  });
  outcome.checked += stuck.length;
  for (const row of stuck) {
    outcome.drifted++;
    outcome.findings.push({
      code: "COIN_BURN_STUCK",
      detail: `CoinBurn ${row.id} (app ${row.appId}) has been ${row.status} since ${row.createdAt.toISOString()} (swap ${row.swapTx ?? "unknown"}): ${row.error ?? "no error recorded"}`,
      coinBurnId: row.id,
      appId: row.appId,
    });
  }
  if (!solanaEnabled()) return;
  const settled = await prisma.coinBurn.groupBy({ by: ["appId"], where: { status: "BURNED" }, _sum: { burnedUnits: true, tokensBurned: true }, _count: { _all: true } });
  for (const row of settled) {
    const app = await prisma.app.findUnique({ where: { id: row.appId }, select: { tokenAddress: true, launchpad: true } });
    if (!app?.tokenAddress) continue;
    outcome.checked += row._count._all;
    const burnedUnits = big(row._sum.burnedUnits);
    if (burnedUnits !== big(row._sum.tokensBurned)) {
      outcome.drifted++;
      outcome.findings.push({ code: "COIN_BURN_PROOF_MISMATCH", detail: `app ${row.appId}: tokensBurned ${big(row._sum.tokensBurned)} sent to burn vs supply delta ${burnedUnits} observed`, appId: row.appId });
    }
    try {
      const state = await adapterFor(app.launchpad).readLaunch(app.tokenAddress);
      if (burnedUnits > state.burnedUnits) {
        outcome.drifted++;
        outcome.findings.push({ code: "COIN_BURNS_EXCEED_CHAIN", detail: `app ${row.appId}: CoinBurn.burnedUnits ${burnedUnits} exceeds on-chain burned supply ${state.burnedUnits}`, appId: row.appId });
      }
    } catch (err) {
      outcome.ok = false;
      outcome.findings.push({ code: "BURN_SUPPLY_UNREADABLE", detail: `mint reads failed for ${app.tokenAddress}: ${err instanceof Error ? err.message : String(err)}`, appId: row.appId });
    }
  }
};
