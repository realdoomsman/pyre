import { prisma, type Prisma } from "@pyre/db";
import { logger } from "./logger.js";

/**
 * Append-only record of privileged actions. Every admin mutation and every money-moving path
 * writes one row so the ops console can answer "who did this, when, and to what".
 */
export type AuditAction =
  | "KILL_APP"
  | "UNKILL_APP"
  | "RESOLVE_FLAG"
  | "REPORT_ACTION"
  | "CANCEL_JOB"
  | "SET_SETTING"
  | "BOUNTY_PAYOUT"
  | "PYRE_UNSTAKE"
  | "FEES_CLAIM"
  | "WALLET_WITHDRAW"
  | "CUSTODIAL_TRADE"
  | "PROPOSAL_STATUS"
  | "PYRE_CLAIM";

export type AuditTargetType = "App" | "BuildJob" | "AbuseFlag" | "Report" | "PlatformSetting" | "Bounty" | "PyreStake" | "User" | "Proposal";

export interface AuditEntry {
  /** User.id of the acting admin, or null for system/worker actions. */
  actorId: string | null;
  /**
   * `admin:<userId>` for console actions, `user:<userId>` for user-triggered treasury movement,
   * `worker:<queue>` for background writers, `system` otherwise.
   */
  actor: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  /** Snapshot of what changed: before/after values, amounts, reasons. */
  meta: Prisma.InputJsonValue;
}

/**
 * Persists one audit row. Rejects when the write fails: callers whose effect is still reversible
 * should let that surface, callers whose effect already landed on-chain should `.catch()` and log.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId,
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      meta: entry.meta,
    },
  });
  logger.info(
    { actor: entry.actor, action: entry.action, targetType: entry.targetType, targetId: entry.targetId },
    "audit",
  );
}

/** Admin-console variant: fills in the `admin:<userId>` actor convention from the request user. */
export async function auditAdmin(
  admin: { id: string },
  action: AuditAction,
  targetType: AuditTargetType,
  targetId: string,
  meta: Prisma.InputJsonValue,
): Promise<void> {
  await writeAudit({ actorId: admin.id, actor: `admin:${admin.id}`, action, targetType, targetId, meta });
}
