import { prisma, type RevenueSource } from "@pyre/db";
import { publishEvent, publishGlobal } from "./publish.js";

export interface RevenueInput {
  app: { id: string; slug: string };
  source: RevenueSource;
  usdMicros: bigint;
  /** Wallet or user id that paid. */
  payer?: string;
  /** Tx signature, function name, campaign id. */
  reference?: string;
  purchaseId?: string;
  /** Human label for the feed note, e.g. "checkout: pro". */
  label: string;
}

/**
 * Every revenue movement: RevenueEvent row, App lifetime + pending counters, firstRevenueAt,
 * TREASURY ledger credit, feed note (ad impressions are too small/frequent for the feed) and a global tick.
 */
export async function recordRevenue(input: RevenueInput): Promise<{ id: string }> {
  const { app, source, usdMicros } = input;
  const event = await prisma.$transaction(async (tx) => {
    const ev = await tx.revenueEvent.create({
      data: {
        appId: app.id,
        source,
        usdMicros,
        payer: input.payer ?? null,
        reference: input.reference ?? null,
        purchaseId: input.purchaseId ?? null,
      },
    });
    await tx.app.update({
      where: { id: app.id },
      data: { revenueMicros: { increment: usdMicros }, pendingRevenueMicros: { increment: usdMicros } },
    });
    await tx.app.updateMany({ where: { id: app.id, firstRevenueAt: null }, data: { firstRevenueAt: new Date() } });
    await tx.ledgerEntry.create({
      data: {
        account: "TREASURY",
        deltaMicros: usdMicros,
        refType: "RevenueEvent",
        refId: ev.id,
        memo: `${source} ${app.slug} ${input.label}`,
      },
    });
    return ev;
  });
  if (source !== "AD") {
    void publishEvent(app.id, {
      type: "AGENT_NOTE",
      text: `Revenue: $${(Number(usdMicros) / 1e6).toFixed(2)} from ${input.label}`,
    });
  }
  void publishGlobal(app.id);
  return { id: event.id };
}
