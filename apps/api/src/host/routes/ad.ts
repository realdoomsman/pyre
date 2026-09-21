import type { Request, Response } from "express";
import { prisma } from "@pyre/db";
import { HttpError } from "../../lib/errors.js";
import type { HostContext } from "../resolve.js";
import { recordRevenue } from "../revenue.js";

const CANDIDATES = 50;

/**
 * `GET /_pyre/ad` — internal ad network. Picks an ACTIVE campaign from another app, weighted by cpm,
 * charges cpm/1000 against the campaign budget and credits the impression as revenue to the host app.
 * 204 when nothing is available.
 */
export async function adRoute(ctx: HostContext, _req: Request, res: Response): Promise<void> {
  if (!ctx.deployment?.manifest.adSlot) throw new HttpError(404, "no ad slot");
  const campaigns = await prisma.adCampaign.findMany({
    where: { status: "ACTIVE", advertiserAppId: { not: ctx.app.id } },
    orderBy: { cpmMicros: "desc" },
    take: CANDIDATES,
  });
  const affordable = campaigns.filter((c) => c.spentMicros + c.cpmMicros / 1000n <= c.budgetMicros);
  if (affordable.length === 0) {
    res.status(204).end();
    return;
  }
  const total = affordable.reduce((sum, c) => sum + Number(c.cpmMicros), 0);
  let ticket = Math.random() * total;
  let chosen = affordable[0]!;
  for (const c of affordable) {
    ticket -= Number(c.cpmMicros);
    if (ticket <= 0) {
      chosen = c;
      break;
    }
  }

  const charge = chosen.cpmMicros / 1000n;
  const claimed = await prisma.adCampaign.updateMany({
    // Guard against a concurrent impression pushing this campaign past its budget.
    where: { id: chosen.id, status: "ACTIVE", spentMicros: { lte: chosen.budgetMicros - charge } },
    data: { spentMicros: { increment: charge }, impressions: { increment: 1 } },
  });
  if (claimed.count === 0) {
    res.status(204).end();
    return;
  }
  await prisma.adCampaign.updateMany({
    where: { id: chosen.id, spentMicros: { gte: chosen.budgetMicros } },
    data: { status: "EXHAUSTED" },
  });
  await prisma.adImpression.create({
    data: { appId: ctx.app.id, advertiserAppId: chosen.advertiserAppId, usdMicros: charge },
  });
  if (charge > 0n) {
    await recordRevenue({
      app: { id: ctx.app.id, slug: ctx.app.slug },
      source: "AD",
      usdMicros: charge,
      payer: chosen.advertiserAppId,
      reference: chosen.id,
      label: `ad impression ${chosen.id}`,
    });
  }
  res.json({
    id: chosen.id,
    headline: chosen.headline,
    body: chosen.body,
    imageUrl: chosen.imageUrl,
    clickUrl: `${ctx.basePath}/_pyre/ad/click/${chosen.id}`,
  });
}

/** `GET /_pyre/ad/click/:campaignId` — counts the click and bounces to the advertiser's app. */
export async function adClickRoute(_ctx: HostContext, _req: Request, res: Response, campaignId: string): Promise<void> {
  const campaign = await prisma.adCampaign.findUnique({
    where: { id: campaignId },
    select: { targetUrl: true },
  });
  if (!campaign) throw new HttpError(404, "unknown campaign");
  let target: URL;
  try {
    target = new URL(campaign.targetUrl);
  } catch {
    throw new HttpError(502, "campaign has an invalid target");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new HttpError(502, "campaign has an invalid target");
  await prisma.adCampaign.update({ where: { id: campaignId }, data: { clicks: { increment: 1 } } });
  res.redirect(302, target.toString());
}
