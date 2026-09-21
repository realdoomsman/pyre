import { prisma } from "@pyre/db";
import { AppSpec, bps } from "@pyre/shared";
import type { Logger } from "pino";
import { appLiveUrl } from "../../env.js";
import { debitAppBudget } from "../../lib/compute.js";
import { publishEvent } from "../../lib/publishEvent.js";
import type { GrowthApp } from "./compose.js";
import { AD_TEST_BUDGET_BPS, AD_TEST_CPM_MICROS, AD_TEST_MAX_BUDGET_MICROS, AD_TEST_MIN_REVENUE_MICROS, DAY_MS } from "./jobs.js";

/**
 * Small internal ad test: apps with ≥ $100 lifetime revenue fund one campaign
 * (min $5, 5% of budget) shown in other Pyre apps' ad slots. At most one live
 * or week-old campaign per app. Returns the campaign id when one was created.
 */
export async function runAdTest(app: GrowthApp, log: Logger): Promise<string | null> {
  if (app.revenueMicros < AD_TEST_MIN_REVENUE_MICROS) return null;
  const budgetMicros = bps(app.budgetMicros, AD_TEST_BUDGET_BPS) < AD_TEST_MAX_BUDGET_MICROS
    ? bps(app.budgetMicros, AD_TEST_BUDGET_BPS)
    : AD_TEST_MAX_BUDGET_MICROS;
  if (budgetMicros <= 0n) return null;

  const [existing, hosts] = await Promise.all([
    prisma.adCampaign.findFirst({
      where: {
        advertiserAppId: app.id,
        OR: [{ status: "ACTIVE" }, { createdAt: { gte: new Date(Date.now() - 7 * DAY_MS) } }],
      },
      select: { id: true },
    }),
    prisma.app.count({ where: { status: "LIVE", id: { not: app.id } } }),
  ]);
  if (existing || hosts === 0) return null;

  const spec = AppSpec.safeParse(app.spec);
  const campaign = await prisma.adCampaign.create({
    data: {
      advertiserAppId: app.id,
      headline: (spec.success ? spec.data.title : app.name).slice(0, 60),
      body: (spec.success ? spec.data.oneLiner : app.name).slice(0, 160),
      imageUrl: app.imageUrl,
      targetUrl: appLiveUrl(app.slug),
      cpmMicros: AD_TEST_CPM_MICROS,
      budgetMicros,
      status: "ACTIVE",
    },
  });
  const memo = `ad test: $${(Number(budgetMicros) / 1e6).toFixed(2)} campaign in other Pyre apps (cpm $${(Number(AD_TEST_CPM_MICROS) / 1e6).toFixed(2)})`;
  await debitAppBudget(app.id, budgetMicros, "AdCampaign", campaign.id, memo);
  const { budgetMicros: remaining } = await prisma.app.findUniqueOrThrow({
    where: { id: app.id },
    select: { budgetMicros: true },
  });
  await publishEvent(app.id, {
    type: "BUDGET",
    budgetUsd: Number(remaining) / 1e6,
    delta: -Number(budgetMicros) / 1e6,
    reason: memo,
  });
  log.info({ appId: app.id, campaignId: campaign.id, budgetMicros: budgetMicros.toString() }, "growth ad test created");
  return campaign.id;
}
