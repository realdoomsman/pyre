import { prisma } from "@pyre/db";
import { GLOBAL_DAILY_COMPUTE_CEILING_USD } from "@pyre/shared";

export const todayKey = (): string => new Date().toISOString().slice(0, 10);

/** Add platform compute spend for today (USD micros). */
export const addDailyCompute = async (micros: bigint): Promise<void> => {
  if (micros <= 0n) return;
  const day = todayKey();
  await prisma.dailyComputeSpend.upsert({
    where: { day },
    create: { day, micros },
    update: { micros: { increment: micros } },
  });
};

/** Remaining platform compute for today (USD micros, floor 0). */
export const dailyComputeRemaining = async (): Promise<bigint> => {
  const row = await prisma.dailyComputeSpend.findUnique({ where: { day: todayKey() } });
  const ceiling = BigInt(GLOBAL_DAILY_COMPUTE_CEILING_USD) * 1_000_000n;
  const spent = row?.micros ?? 0n;
  return spent >= ceiling ? 0n : ceiling - spent;
};

/**
 * Debit an app's build budget by an actual cost: budgetMicros -= cost (floor 0),
 * spentMicros += cost, negative LedgerEntry on BUILD:<appId>. Daily compute is
 * NOT touched here: proxied agent spend is already counted by the API proxy, so
 * callers add only runner-side (real key) usage via `addDailyCompute`.
 */
export const debitAppBudget = async (
  appId: string,
  micros: bigint,
  refType: string,
  refId: string,
  memo?: string,
): Promise<void> => {
  if (micros <= 0n) return;
  await prisma.$transaction(async (tx) => {
    const app = await tx.app.findUniqueOrThrow({ where: { id: appId }, select: { budgetMicros: true } });
    const next = app.budgetMicros > micros ? app.budgetMicros - micros : 0n;
    await tx.app.update({
      where: { id: appId },
      data: { budgetMicros: next, spentMicros: { increment: micros } },
    });
    await tx.ledgerEntry.create({
      data: { account: `BUILD:${appId}`, deltaMicros: -micros, refType, refId, memo: memo ?? null },
    });
  });
};
