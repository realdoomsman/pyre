import { TwitterApi } from "twitter-api-v2";
import { env } from "../../env.js";

export type Mention = { id: string; text: string; authorId: string; createdAt: string };

type Identity = { id: string; username: string };

let client: TwitterApi | null | undefined;
let identity: Identity | null = null;

/** Lazily constructed X client; `null` when any X_API_* variable is missing. */
export function xClient(): TwitterApi | null {
  if (client !== undefined) return client;
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = env;
  client =
    X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_SECRET
      ? new TwitterApi({
          appKey: X_API_KEY,
          appSecret: X_API_SECRET,
          accessToken: X_ACCESS_TOKEN,
          accessSecret: X_ACCESS_SECRET,
        })
      : null;
  return client;
}

/** Authenticated platform account (cached for the process lifetime). */
export async function xIdentity(x: TwitterApi): Promise<Identity> {
  if (identity) return identity;
  const me = await x.v2.me();
  identity = { id: me.data.id, username: me.data.username };
  return identity;
}

export const tweetUrl = (username: string, id: string) => `https://x.com/${username}/status/${id}`;

/** Posts a thread (1..n tweets); returns the URL of the first tweet. */
export async function postThread(x: TwitterApi, tweets: string[]): Promise<string> {
  const { username } = await xIdentity(x);
  if (tweets.length === 1) {
    const res = await x.v2.tweet(tweets[0]!);
    return tweetUrl(username, res.data.id);
  }
  const res = await x.v2.tweetThread(tweets);
  return tweetUrl(username, res[0]!.data.id);
}

export async function postReply(x: TwitterApi, text: string, toTweetId: string): Promise<string> {
  const { username } = await xIdentity(x);
  const res = await x.v2.reply(text, toTweetId);
  return tweetUrl(username, res.data.id);
}

/** Mentions of the platform account since `since`, newest first, capped at 300. */
export async function fetchMentions(x: TwitterApi, since: Date): Promise<Mention[]> {
  const { id } = await xIdentity(x);
  const paginator = await x.v2.userMentionTimeline(id, {
    max_results: 100,
    start_time: since.toISOString(),
    "tweet.fields": ["author_id", "created_at", "text"],
  });
  const out: Mention[] = [];
  for await (const t of paginator) {
    out.push({ id: t.id, text: t.text, authorId: t.author_id ?? "", createdAt: t.created_at ?? "" });
    if (out.length >= 300) break;
  }
  return out;
}
