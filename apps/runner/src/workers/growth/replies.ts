import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { composeReply, type GrowthApp } from "./compose.js";
import { MAX_REPLIES_PER_DAY, MIN_GROWTH_BUDGET_MICROS, REPLIED_SET_TTL_SEC } from "./jobs.js";
import { publishPost } from "./post.js";
import type { Mention } from "./x.js";

/**
 * Replies once to each unanswered mention that names the app's ticker, at most
 * MAX_REPLIES_PER_DAY per app. Dedupe lives in Redis (7d set + daily counter).
 * Returns the number of replies posted.
 */
export async function replyToMentions(
  app: GrowthApp,
  mentions: Mention[],
  redis: Redis,
  log: Logger,
): Promise<number> {
  const ticker = app.ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namesTicker = new RegExp(`(?:^|[^A-Za-z0-9])\\$?${ticker}(?![A-Za-z0-9])`, "i");
  const candidates = mentions.filter((m) => namesTicker.test(m.text));
  if (!candidates.length) return 0;

  const repliedKey = `growth:replied:${app.id}`;
  const dayKey = `growth:replies:${app.id}:${new Date().toISOString().slice(0, 10)}`;
  let today = Number((await redis.get(dayKey)) ?? 0);
  let budgetMicros = app.budgetMicros;
  let posted = 0;

  for (const mention of candidates) {
    if (today >= MAX_REPLIES_PER_DAY) break;
    if (budgetMicros < MIN_GROWTH_BUDGET_MICROS) break;
    if (await redis.sismember(repliedKey, mention.id)) continue;

    // Claim before composing so a concurrent run cannot double-reply.
    await redis.sadd(repliedKey, mention.id);
    await redis.expire(repliedKey, REPLIED_SET_TTL_SEC);
    today = await redis.incr(dayKey);
    await redis.expire(dayKey, 2 * 24 * 3600);
    if (today > MAX_REPLIES_PER_DAY) break;

    const { tweets, costMicros } = await composeReply(app, mention.text);
    const result = await publishPost(app, tweets, costMicros, `growth reply to mention ${mention.id}`, log, mention.id);
    budgetMicros -= result.costMicros;
    if (result.url) posted++;
    log.info({ appId: app.id, mentionId: mention.id, url: result.url }, "growth mention reply");
  }
  return posted;
}
