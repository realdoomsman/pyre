import { prisma } from "@pyre/db";
import { getEthPriceUsd, publicClient } from "@pyre/chain";
import { usdMicrosFromWei } from "@pyre/shared";
import type { Hash } from "viem";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import type { WorkerContext } from "../../lib/queues.js";
import { emptyOutcome, type CheckOutcome } from "./report.js";

/**
 * PAYOUTS: settle treasury payouts the API broadcast but could not confirm. The API never rolls
 * back a payout whose receipt it failed to read (it may still mine); instead it leaves the funds
 * marked as paid and writes a `PAYOUT_UNCONFIRMED` audit row with the tx hash. Each pass reads
 * the receipt: a successful one finalises what the API would have written after the transfer, a
 * reverted one releases the funds, and a missing one is reported until it appears. Every resolved
 * row gets a `PAYOUT_RESOLVED` audit pointing back at it, which is how the next pass skips it.
 */

const BigIntStr = z.string().regex(/^-?\d+$/).transform((v) => BigInt(v));
const TxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((h) => h as Hash);

const Unconfirmed = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("FEES_CLAIM"), txHash: TxHash, userId: z.string(), usdMicros: BigIntStr, wei: BigIntStr }),
  z.object({ kind: z.literal("PYRE_UNSTAKE"), txHash: TxHash }),
  z.object({
    kind: z.literal("PYRE_CLAIM"),
    txHash: TxHash,
    userId: z.string(),
    usdMicros: BigIntStr,
    stakes: z.array(z.object({ id: z.string(), appId: z.string(), earnedMicros: BigIntStr })),
  }),
  z.object({ kind: z.literal("BOUNTY_PAYOUT"), txHash: TxHash, wei: BigIntStr }),
]);
type Unconfirmed = z.infer<typeof Unconfirmed>;

const Resolved = z.object({ unconfirmedId: z.string() });

/** A broadcast older than this with no receipt was dropped by the network; it is reported as drift, not just pending. */
const STALE_AFTER_MS = 60 * 60_000;

type Receipt = "success" | "reverted" | "missing";

const readReceipt = async (hash: Hash): Promise<Receipt> => {
  try {
    const receipt = await publicClient().getTransactionReceipt({ hash });
    return receipt.status === "success" ? "success" : "reverted";
  } catch {
    return "missing";
  }
};

/** What the API would have written after a confirmed transfer, for each payout kind. */
const finalize = async (targetId: string, payout: Unconfirmed): Promise<void> => {
  switch (payout.kind) {
    case "FEES_CLAIM":
      await prisma.$transaction([
        prisma.ledgerEntry.update({ where: { id: targetId }, data: { memo: `fees claim ${payout.txHash}` } }),
        prisma.ledgerEntry.create({ data: { account: "TREASURY", deltaMicros: -payout.usdMicros, refType: "Payout", refId: payout.userId, memo: `fees claim ${payout.txHash}` } }),
      ]);
      return;
    case "PYRE_UNSTAKE":
      // `withdrawnAt` and `withdrawTx` were already set by the API; the confirmed receipt makes them true.
      return;
    case "PYRE_CLAIM": {
      const byApp: Record<string, bigint> = {};
      for (const s of payout.stakes) byApp[s.appId] = (byApp[s.appId] ?? 0n) + s.earnedMicros;
      await prisma.ledgerEntry.createMany({
        data: [
          ...Object.entries(byApp).map(([appId, micros]) => ({ account: `STAKERS:${appId}`, deltaMicros: -micros, refType: "Payout", refId: payout.userId, memo: `staker rewards ${payout.txHash}` })),
          { account: "TREASURY", deltaMicros: -payout.usdMicros, refType: "Payout", refId: payout.userId, memo: `staker rewards ${payout.txHash}` },
        ],
      });
      return;
    }
    case "BOUNTY_PAYOUT": {
      const usdMicros = usdMicrosFromWei(payout.wei, await getEthPriceUsd());
      await prisma.$transaction([
        prisma.ledgerEntry.create({ data: { account: "TREASURY", deltaMicros: -usdMicros, refType: "Payout", refId: targetId, memo: `bounty payout ${payout.txHash}` } }),
        prisma.bounty.updateMany({ where: { id: targetId, status: "CLAIMED" }, data: { status: "PAID", payoutTx: payout.txHash } }),
      ]);
      return;
    }
  }
};

/** Release the funds the API held back: the transaction mined and reverted, nothing moved. */
const release = async (targetId: string, payout: Unconfirmed): Promise<void> => {
  switch (payout.kind) {
    case "FEES_CLAIM":
      await prisma.ledgerEntry.deleteMany({ where: { id: targetId } });
      return;
    case "PYRE_UNSTAKE":
      await prisma.pyreStake.update({ where: { id: targetId }, data: { withdrawnAt: null, withdrawTx: null } });
      return;
    case "PYRE_CLAIM":
      // Increment, never set: sweeps may have credited these stakes since the claim cleared them.
      for (const s of payout.stakes) await prisma.pyreStake.update({ where: { id: s.id }, data: { earnedMicros: { increment: s.earnedMicros } } });
      return;
    case "BOUNTY_PAYOUT":
      await prisma.bounty.updateMany({
        where: { id: targetId, status: "CLAIMED" },
        data: { status: "OPEN", claimantId: null, claimantWallet: null, prNumber: null, claimedAt: null, payoutTx: null },
      });
      return;
  }
};

export const checkPayouts = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const log = ctx.log.child({ worker: "reconcile", check: "PAYOUTS" });
  const [unconfirmed, resolved] = await Promise.all([
    prisma.auditLog.findMany({ where: { action: "PAYOUT_UNCONFIRMED" }, orderBy: { createdAt: "asc" } }),
    prisma.auditLog.findMany({ where: { action: "PAYOUT_RESOLVED" }, select: { meta: true } }),
  ]);
  const done: Record<string, true> = {};
  for (const r of resolved) {
    const parsed = Resolved.safeParse(r.meta);
    if (parsed.success) done[parsed.data.unconfirmedId] = true;
  }
  const open = unconfirmed.filter((u) => !done[u.id]);
  outcome.checked = open.length;

  for (const row of open) {
    const parsed = Unconfirmed.safeParse(row.meta);
    if (!parsed.success) {
      outcome.ok = false;
      outcome.findings.push({ code: "PAYOUT_META_UNREADABLE", detail: `audit ${row.id} (${row.targetType} ${row.targetId}) has no usable payout meta` });
      continue;
    }
    const payout = parsed.data;
    const receipt = await readReceipt(payout.txHash);
    if (receipt === "missing") {
      const stale = Date.now() - row.createdAt.getTime() > STALE_AFTER_MS;
      if (stale) outcome.drifted++;
      outcome.findings.push({
        code: stale ? "PAYOUT_DROPPED" : "PAYOUT_PENDING",
        detail: `${payout.kind} ${payout.txHash} for ${row.targetType} ${row.targetId} has no receipt yet`,
        auditId: row.id,
      });
      continue;
    }
    try {
      if (receipt === "success") await finalize(row.targetId, payout);
      else await release(row.targetId, payout);
    } catch (err) {
      outcome.ok = false;
      outcome.findings.push({
        code: "PAYOUT_RESOLVE_FAILED",
        detail: `${payout.kind} ${payout.txHash} ${receipt}: ${err instanceof Error ? err.message : String(err)}`,
        auditId: row.id,
      });
      log.error({ err, auditId: row.id, kind: payout.kind, txHash: payout.txHash }, "unconfirmed payout could not be settled");
      continue;
    }
    outcome.repaired++;
    outcome.findings.push({ code: receipt === "success" ? "PAYOUT_CONFIRMED" : "PAYOUT_REVERTED", detail: `${payout.kind} ${payout.txHash} for ${row.targetType} ${row.targetId}`, auditId: row.id });
    await audit({
      actor: "worker:reconcile",
      action: "PAYOUT_RESOLVED",
      targetType: row.targetType,
      targetId: row.targetId,
      meta: { unconfirmedId: row.id, kind: payout.kind, txHash: payout.txHash, receipt },
    });
    log.info({ auditId: row.id, kind: payout.kind, txHash: payout.txHash, receipt }, "unconfirmed payout settled");
  }
  return outcome;
};
