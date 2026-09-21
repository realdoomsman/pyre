import type { App } from "@pyre/db";
import { prisma } from "@pyre/db";
import type { Logger } from "pino";
import { env } from "../../env.js";
import { debitAppBudget } from "../../lib/compute.js";
import { publishEvent } from "../../lib/publishEvent.js";
import { POST_OPS_FEE_MICROS } from "./jobs.js";
import { postReply, postThread, xClient } from "./x.js";

export const coinUrl = (slug: string) => `${env.WEB_ORIGIN}/c/${slug}`;

export type PostResult = { url: string; text: string; costMicros: bigint };

/**
 * Posts `tweets` to X (thread when >1, reply when `replyTo` is set), records a
 * GROWTH_POST feed event either way, and debits the app budget by LLM cost plus
 * the per-post ops fee (fee only when something actually went out).
 */
export async function publishPost(
  app: Pick<App, "id" | "slug">,
  tweets: string[],
  llmCostMicros: bigint,
  memo: string,
  log: Logger,
  replyTo?: string,
): Promise<PostResult> {
  const body = tweets.join("\n\n");
  const x = xClient();
  let url = "";
  let text = body;
  if (!x) {
    log.warn({ appId: app.id }, "X_API_* not configured; recording growth post without publishing");
    text = `[X not connected] ${body}`;
  } else {
    try {
      url = replyTo ? await postReply(x, tweets[0]!, replyTo) : await postThread(x, tweets);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error({ appId: app.id, err: reason }, "X post failed");
      text = `[X post failed: ${reason}] ${body}`;
    }
  }

  const event = await publishEvent(app.id, { type: "GROWTH_POST", url, text });
  const costMicros = llmCostMicros + (url ? POST_OPS_FEE_MICROS : 0n);
  if (costMicros > 0n) {
    await debitAppBudget(app.id, costMicros, "BuildEvent", event.id, memo);
    const { budgetMicros } = await prisma.app.findUniqueOrThrow({
      where: { id: app.id },
      select: { budgetMicros: true },
    });
    await publishEvent(app.id, {
      type: "BUDGET",
      budgetUsd: Number(budgetMicros) / 1e6,
      delta: -Number(costMicros) / 1e6,
      reason: memo,
    });
  }
  return { url, text, costMicros };
}
