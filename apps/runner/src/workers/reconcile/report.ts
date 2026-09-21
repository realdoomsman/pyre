import { prisma } from "@pyre/db";
import { audit, jsonSafe } from "../../lib/audit.js";
import type { WorkerContext } from "../../lib/queues.js";

/** `ReconcileRun.kind`: one row per check per pass. */
export type ReconcileKind = "JOBS" | "SANDBOXES" | "JOBTOKENS" | "LEDGER" | "FEES" | "BURNS";

/** One machine-readable observation. `code` is stable; the rest is context for an operator. */
export interface Finding {
  code: string;
  detail: string;
  appId?: string;
  jobId?: string;
  [key: string]: unknown;
}

export interface CheckOutcome {
  /** false when the check itself could not complete (provider down, RPC error). */
  ok: boolean;
  /** Rows/objects inspected. */
  checked: number;
  /** Inconsistencies observed. */
  drifted: number;
  /** Inconsistencies this pass actually corrected. */
  repaired: number;
  findings: Finding[];
}

export type Check = (ctx: WorkerContext) => Promise<CheckOutcome>;

export const emptyOutcome = (): CheckOutcome => ({ ok: true, checked: 0, drifted: 0, repaired: 0, findings: [] });

/**
 * Runs one check, writes its `ReconcileRun` row, and — when it repaired anything —
 * an `AuditLog` row pointing at that run. A thrown check is recorded as `ok: false`
 * rather than failing the whole pass.
 */
export const runCheck = async (kind: ReconcileKind, ctx: WorkerContext, check: Check): Promise<CheckOutcome> => {
  const log = ctx.log.child({ worker: "reconcile", check: kind });
  const startedAt = Date.now();
  let outcome: CheckOutcome;
  try {
    outcome = await check(ctx);
  } catch (err) {
    log.error({ err }, "reconcile check crashed");
    outcome = {
      ok: false,
      checked: 0,
      drifted: 0,
      repaired: 0,
      findings: [{ code: "CHECK_CRASHED", detail: err instanceof Error ? err.message : String(err) }],
    };
  }
  const durationMs = Date.now() - startedAt;
  const run = await prisma.reconcileRun.create({
    data: {
      kind,
      ok: outcome.ok,
      checked: outcome.checked,
      drifted: outcome.drifted,
      repaired: outcome.repaired,
      findings: jsonSafe(outcome.findings),
      durationMs,
    },
    select: { id: true },
  });
  if (outcome.repaired > 0) {
    await audit({
      actor: "worker:reconcile",
      action: "RECONCILE",
      targetType: "ReconcileRun",
      targetId: run.id,
      meta: { kind, repaired: outcome.repaired, drifted: outcome.drifted, findings: outcome.findings },
    });
  }
  const line = {
    runId: run.id,
    ok: outcome.ok,
    checked: outcome.checked,
    drifted: outcome.drifted,
    repaired: outcome.repaired,
    durationMs,
    findings: outcome.findings,
  };
  if (!outcome.ok || outcome.drifted > 0) log.warn(line, "reconcile check found drift");
  else log.info(line, "reconcile check clean");
  return outcome;
};
