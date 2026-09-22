import type { App } from "@pyre/db";
import { prisma } from "@pyre/db";
import { AppSpec, ponsUrl } from "@pyre/shared";
import { z } from "zod";
import { appLiveUrl, models } from "../../env.js";
import { askJson } from "../../lib/anthropic.js";
import { coinUrl } from "./post.js";

export type GrowthApp = Pick<
  App,
  "id" | "slug" | "name" | "ticker" | "imageUrl" | "spec" | "tokenAddress" | "budgetMicros" | "usersCount" | "liveVersion"
>;

export const GROWTH_APP_SELECT = {
  id: true,
  slug: true,
  name: true,
  ticker: true,
  imageUrl: true,
  spec: true,
  tokenAddress: true,
  budgetMicros: true,
  usersCount: true,
  liveVersion: true,
} as const;

const SYSTEM = `You write short X (Twitter) posts for an app built autonomously by an AI agent on Pyre, a launchpad on Robinhood Chain where each coin's creator fees pay an agent to build and improve the coin's app, and a share of every coin's fees buys and burns PYRE.
Rules:
- Plain, factual, specific. Say what shipped or what changed. No hype words, no emojis, at most one hashtag, no exclamation marks.
- Never mention token price, market cap, gains, "buy", "moon", or anything that reads as investment advice or a promise of returns.
- Never invent features, numbers, or users. Only use facts in the brief.
- Each tweet must be at most 260 characters. Include the link exactly once, in the first tweet.
- Refer to the coin by its ticker as $TICKER.
Respond with JSON only.`;

const Tweets = z.object({ tweets: z.array(z.string().min(1).max(280)).min(1).max(3) });

export type EventLine = { type: string; at: Date; text: string };

const EVENT_LINE: Record<string, (p: Record<string, unknown>) => string> = {
  DEPLOY: (p) => `deployed version ${String(p.version)}`,
  COMMIT: (p) => `commit: ${String(p.message ?? "").split("\n")[0]}`,
  MILESTONE: (p) => `milestone: ${String(p.milestone)} (${String(p.value)})`,
  PR_MERGED: (p) => `merged community PR #${String(p.prNumber)} by ${String(p.author)}`,
};

/** DEPLOY/COMMIT/MILESTONE/PR_MERGED events since `since`, oldest first. */
export async function recentEvents(appId: string, since: Date): Promise<EventLine[]> {
  const rows = await prisma.buildEvent.findMany({
    where: { appId, createdAt: { gte: since }, type: { in: Object.keys(EVENT_LINE) } },
    orderBy: { createdAt: "asc" },
    take: 60,
    select: { type: true, payload: true, createdAt: true },
  });
  return rows.map((r) => ({
    type: r.type,
    at: r.createdAt,
    text: EVENT_LINE[r.type]!((r.payload ?? {}) as Record<string, unknown>),
  }));
}

function brief(app: GrowthApp, events: EventLine[]): string {
  const spec = AppSpec.safeParse(app.spec);
  const lines = [
    `App: ${app.name} ($${app.ticker})`,
    `App URL: ${appLiveUrl(app.slug)}`,
    `Coin page: ${coinUrl(app.slug)}`,
    ...(app.tokenAddress ? [`Trade on PONS: ${ponsUrl(app.tokenAddress)}`] : []),
    `Live version: ${app.liveVersion}`,
    `Users so far: ${app.usersCount}`,
  ];
  if (spec.success) {
    lines.push(
      `One-liner: ${spec.data.oneLiner}`,
      `What it does: ${spec.data.whatItDoes}`,
      `MVP scope: ${spec.data.mvp.join("; ")}`,
    );
  }
  if (events.length) {
    lines.push("Recent build events (oldest first):");
    for (const e of events) lines.push(`- [${e.at.toISOString()}] ${e.text}`);
  }
  return lines.join("\n");
}

export type Composed = { tweets: string[]; costMicros: bigint };

/** One structured LLM call; cost is accounted by the caller when it debits the app. */
async function compose(app: GrowthApp, events: EventLine[], task: string, maxTweets: number): Promise<Composed> {
  const { value, costMicros } = await askJson({
    model: models.GROWTH,
    system: SYSTEM,
    user: `${brief(app, events)}\n\nTask: ${task}\nReturn {"tweets": string[]} with at most ${maxTweets} tweet(s).`,
    schema: Tweets,
    maxTokens: 600,
    toolName: "tweets",
  });
  return { tweets: value.tweets.slice(0, maxTweets).map((t) => t.trim().slice(0, 280)), costMicros };
}

export const composeChangelog = (app: GrowthApp, events: EventLine[]) =>
  compose(
    app,
    events,
    "Write a changelog thread (1-3 tweets) summarizing what the agent shipped in the last 24 hours. First tweet: the headline change + app URL. Later tweets: notable details. Skip anything not in the events.",
    3,
  );

export const composeDeploy = (app: GrowthApp, events: EventLine[], version: number) =>
  compose(
    app,
    events,
    `Write one tweet announcing that version ${version} of the app is live, naming the most user-visible change from the events, with the app URL.`,
    1,
  );

export const composeRevive = (app: GrowthApp) =>
  compose(
    app,
    [],
    "Write one tweet saying the app's build budget was replenished by holders and the agent has resumed building, with the coin page link. Mention what the app does in a few words.",
    1,
  );

export const composeReply = (app: GrowthApp, mention: string) =>
  compose(
    app,
    [],
    `Someone mentioned the platform account and this app's ticker. Their post: """${mention.slice(0, 500)}""". Write one short, helpful reply (max 240 chars) that answers any question using only the brief, points to the app URL, and never discusses price. Do not start with the link.`,
    1,
  );
