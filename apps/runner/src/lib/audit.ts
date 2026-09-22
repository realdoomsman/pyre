import { prisma, type Prisma } from "@pyre/db";
import { log } from "./logger.js";

/**
 * Append-only record of every privileged or money-moving action a worker takes.
 * Writes are best effort by design: losing the audit row must never abort the
 * money path it describes, so a failure is logged loudly and swallowed.
 */

/** `"admin:<userId>"` for operator actions, `"worker:<queue>"` for workers, `"system"` for boot/shutdown. */
export type AuditActor = `admin:${string}` | `worker:${string}` | "system";

/** Action vocabulary. Kept closed so the admin UI can label rows without guessing. */
export type AuditAction =
  | "FEE_SWEEP"
  | "FEE_CREDIT"
  | "BUYBACK_BURN"
  | "BUDGET_DEBIT"
  | "REAP_JOB"
  | "APP_STATUS"
  | "PROPOSAL_STATUS"
  | "APP_LAUNCH"
  | "APP_WALLET_FUND"
  | "APP_WALLET_DRAIN"
  | "BOUNTY_PAYOUT"
  | "STAKE_REFUND"
  | "CREDIT_FUNDING"
  | "PLATFORM_FEE_CLAIM"
  | "PYRE_BURN"
  | "COIN_BURN"
  | "KILL_SANDBOX"
  | "REVOKE_TOKEN"
  | "RECONCILE"
  /** A `PAYOUT_UNCONFIRMED` row from the API was settled from its receipt (meta.unconfirmedId points at it). */
  | "PAYOUT_RESOLVED"
  | "SHUTDOWN";

export interface AuditInput {
  actor: AuditActor;
  action: AuditAction;
  /** Prisma model name of the subject: App | BuildJob | FeeEvent | PyreBurn | Bounty | ReconcileRun | JobToken. */
  targetType: string;
  targetId: string;
  meta?: unknown;
  actorId?: string | null;
}

/**
 * BigInt is the money type everywhere in this codebase and `Json` columns cannot
 * hold it, so payloads are serialized with bigints widened to decimal strings.
 * Shared with `ReconcileRun.findings`, which has the same problem.
 */
export const jsonSafe = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value ?? {}, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as Prisma.InputJsonValue;

export const audit = async (input: AuditInput): Promise<void> => {
  try {
    await prisma.auditLog.create({
      data: {
        actor: input.actor,
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        meta: jsonSafe(input.meta),
      },
    });
  } catch (err) {
    log.error(
      { err, action: input.action, actor: input.actor, targetType: input.targetType, targetId: input.targetId },
      "audit write failed",
    );
  }
};
