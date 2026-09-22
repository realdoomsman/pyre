import {
  big,
  type Decimalish,
  type App,
  type JobStatus,
  type Bounty,
  type BuildEvent,
  type BuildJob,
  type Candle,
  type CoinBurn,
  type FeeEvent,
  type Notification,
  type PromptQueueItem,
  type Proposal,
  type PullRequest,
  type PyreStake,
  type PyreBurn,
  type Trade,
  type User,
} from "@pyre/db";
import {
  AppSpec,
  BuildEventPayload,
  LaunchPhase,
  VENUES,
  unitsToNumber,
  type AgentState,
  type AppSummaryDto,
  type BountyDto,
  type BuildEventDto,
  type BuildJobDto,
  type CandleDto,
  type Chain,
  type CoinBurnDto,
  type FeeEventDto,
  type HolderDto,
  type LaunchDraftDto,
  type NotificationDto,
  type ProposalDto,
  type PullRequestDto,
  type PyreBurnDto,
  type PyreStakeDto,
  type QueueItemDto,
  type TradeDto,
  type UserRefDto,
} from "@pyre/shared";
import type { Address } from "viem";
import { DEAD_ADDRESS, ponsAddresses } from "@pyre/chain";
import { env } from "../env.js";
import { db } from "./metrics.js";
import { TREASURY_WALLET } from "./treasury.js";
import { adapterOf, links, metaOf, requiredStake, type VenueRow } from "./venue.js";
import { PLATFORM_PROPOSAL_QUORUM, SUPPLY_BASE_UNITS } from "./votes.js";

export const usd = (micros: bigint): number => Number(micros) / 1e6;
/** Display tokens for a base-unit amount (18 decimals unless the coin says otherwise). */
export const tokens = (units: bigint, decimals = 18): number => unitsToNumber(units, decimals);
/** Percent of a launch supply (PONS by default), 0..100 with four decimals. */
export const pctOfSupply = (units: bigint, supply: bigint = SUPPLY_BASE_UNITS): number => Number((units * 1_000_000n) / supply) / 10_000;

/** Native/USD prices the read paths carry, from the runner's market snapshot. */
export interface NativePrices {
  ethPriceUsd: number;
  solPriceUsd: number;
}

export const nativePriceOf = (prices: NativePrices, chain: Chain): number => (chain === "solana" ? prices.solPriceUsd : prices.ethPriceUsd);

/** Display-precision USD value of native base units on `chain`. */
export const nativeUsd = (units: bigint, chain: Chain, prices: NativePrices): number =>
  unitsToNumber(units, chain === "solana" ? 9 : 18) * nativePriceOf(prices, chain);

export const liveUrl = (slug: string): string =>
  env.APP_DOMAIN ? `https://${slug}.${env.APP_DOMAIN}` : `${env.API_ORIGIN}/a/${slug}`;

/** Statuses that expose a live URL. */
const SERVABLE: Record<string, true> = { LIVE: true, DORMANT: true };

const iso = (d: Date | null | undefined): string | null => d?.toISOString() ?? null;

/* ─────────────────────────── Aggregates shared by list routes ─────────────────────────── */

export interface AppExtras {
  fees24hWei: bigint;
}

const DAY_MS = 86_400_000;

/**
 * Per-app 24h swept fees for a page of apps: one grouped aggregate regardless of page size.
 * Feeds the heat index and the trending sort.
 */
export const appExtrasByApp = async (appIds: string[]): Promise<Record<string, AppExtras>> => {
  const out: Record<string, AppExtras> = {};
  if (appIds.length === 0) return out;
  const since = new Date(Date.now() - DAY_MS);
  const fees = await db.feeEvent.groupBy({ by: ["appId"], where: { appId: { in: appIds }, createdAt: { gte: since } }, _sum: { wei: true } });
  for (const id of appIds) out[id] = { fees24hWei: 0n };
  for (const f of fees) out[f.appId]!.fees24hWei = big(f._sum.wei);
  return out;
};

/* ─────────────────────────── Heat + agent state ─────────────────────────── */

export interface HeatInputs {
  /** 24h swept creator fees in USD (native × the chain's price). */
  fees24hUsd: number;
  /** 24h trade volume in USD (the `App.volume24hUsd` the price worker refreshes). */
  volume24hUsd: number;
}

/**
 * Heat index in [0, 1): how much of the loop is turning right now. Two signals, each scaled to
 * a "warm" daily figure so nothing saturates early, combined 60/40 and squashed with 1 − e^(−x)
 * so a runaway coin still stays below 1:
 *   - creator fees swept in 24h (weight .6, warm at $50: what is actually paying the agent)
 *   - trade volume in 24h       (weight .4, warm at $5,000: the fees still accruing on the curve)
 */
export const heatIndex = (h: HeatInputs): number => {
  const fees = h.fees24hUsd / 50;
  const volume = h.volume24hUsd / 5_000;
  const x = 0.6 * fees + 0.4 * volume;
  const heat = 1 - Math.exp(-x);
  return Number.isFinite(heat) ? Math.min(0.999, Math.max(0, heat)) : 0;
};

export type JobSummaryRow = Pick<BuildJob, "id" | "stage" | "status" | "model" | "budgetMicros" | "costMicros" | "summary" | "error" | "startedAt" | "finishedAt" | "createdAt">;

/** What the agent is doing, from the newest active job (RUNNING or QUEUED) and the app status. */
export const agentState = (status: App["status"], activeJob: Pick<BuildJob, "stage"> | null | undefined): AgentState => {
  if (activeJob) {
    if (activeJob.stage === "PR_REVIEW") return "reviewing";
    if (activeJob.stage === "DEPLOY" || activeJob.stage === "VERIFY") return "deploying";
    return "building";
  }
  return status === "DORMANT" ? "dormant" : "idle";
};

/* ─────────────────────────── Users / events / jobs ─────────────────────────── */

/** Columns `userRef` reads; a full `User` row satisfies it. */
export type UserRefRow = Pick<User, "id" | "displayName" | "avatarUrl" | "wallet" | "xHandle">;

/** Prisma select matching `UserRefRow`. */
export const USER_REF_SELECT = { id: true, displayName: true, avatarUrl: true, wallet: true, xHandle: true } as const;

export const userRef = (u: UserRefRow): UserRefDto => ({
  id: u.id,
  displayName: u.displayName,
  avatarUrl: u.avatarUrl,
  wallet: u.wallet as Address | null,
  xHandle: u.xHandle,
});

export const eventDto = (e: BuildEvent): BuildEventDto => ({
  id: e.id,
  appId: e.appId,
  jobId: e.jobId,
  type: e.type,
  payload: e.payload as BuildEventPayload,
  createdAt: e.createdAt.toISOString(),
});

export const jobDto = (j: JobSummaryRow): BuildJobDto => ({
  id: j.id,
  stage: j.stage,
  status: j.status,
  model: j.model,
  budgetMicros: j.budgetMicros.toString(),
  costMicros: j.costMicros.toString(),
  summary: j.summary,
  error: j.error,
  startedAt: iso(j.startedAt),
  finishedAt: iso(j.finishedAt),
  createdAt: j.createdAt.toISOString(),
});

/* ─────────────────────────── App summary ─────────────────────────── */

/** Jobs that mean "the agent is on it" for `agentState`. */
const ACTIVE_JOB_STATUSES: JobStatus[] = ["RUNNING", "QUEUED"];

const JOB_SUMMARY_SELECT = {
  id: true,
  stage: true,
  status: true,
  model: true,
  budgetMicros: true,
  costMicros: true,
  summary: true,
  error: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
} as const;

/**
 * Prisma select used by every endpoint that returns an AppSummaryDto: exactly the columns
 * `appSummary` reads plus the newest active job. Routes needing more spread this and add
 * their own columns — never a `Bytes` column.
 */
export const APP_SUMMARY_SELECT = {
  id: true,
  slug: true,
  name: true,
  ticker: true,
  imageUrl: true,
  status: true,
  template: true,
  spec: true,
  chain: true,
  launchpad: true,
  tokenAddress: true,
  curveAddress: true,
  poolId: true,
  launchPhase: true,
  progress: true,
  priceUsd: true,
  marketCapUsd: true,
  change24hPct: true,
  volume24hUsd: true,
  holdersCount: true,
  budgetMicros: true,
  feesWei: true,
  liveVersion: true,
  createdAt: true,
  launchedAt: true,
  graduatedAt: true,
  launcher: { select: USER_REF_SELECT },
  jobs: { where: { status: { in: ACTIVE_JOB_STATUSES } }, take: 1, orderBy: { createdAt: "desc" }, select: JOB_SUMMARY_SELECT },
} as const;

/** Columns `appSummary` reads. Structural so list queries select exactly these; a full `App` row + relations satisfies it. */
export type AppSummaryRow = Pick<
  App,
  | "id"
  | "slug"
  | "name"
  | "ticker"
  | "imageUrl"
  | "status"
  | "template"
  | "spec"
  | "chain"
  | "launchpad"
  | "tokenAddress"
  | "curveAddress"
  | "poolId"
  | "launchPhase"
  | "progress"
  | "priceUsd"
  | "marketCapUsd"
  | "change24hPct"
  | "volume24hUsd"
  | "holdersCount"
  | "budgetMicros"
  | "feesWei"
  | "liveVersion"
  | "createdAt"
  | "launchedAt"
  | "graduatedAt"
> & { launcher: UserRefRow; jobs: JobSummaryRow[] };

export const appSummary = (a: AppSummaryRow, extras: AppExtras, prices: NativePrices): AppSummaryDto => {
  const spec = AppSpec.safeParse(a.spec);
  const phase = LaunchPhase.safeParse(a.launchPhase);
  const venue = metaOf(a);
  const link = links(a);
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    ticker: a.ticker,
    imageUrl: a.imageUrl,
    oneLiner: spec.success ? spec.data.oneLiner : "",
    status: a.status,
    template: a.template,
    chain: a.chain,
    launchpad: a.launchpad,
    native: venue.native,
    tokenAddress: a.tokenAddress,
    curveAddress: a.curveAddress,
    poolId: a.poolId,
    phase: phase.success ? phase.data : 0,
    progress: a.launchPhase >= 2 ? 1 : Math.min(1, Math.max(0, a.progress)),
    priceUsd: a.priceUsd,
    mcapUsd: a.marketCapUsd,
    change24hPct: a.tokenAddress ? a.change24hPct : null,
    volume24hUsd: a.volume24hUsd,
    holders: a.holdersCount,
    budgetMicros: a.budgetMicros.toString(),
    feesWei: big(a.feesWei).toString(),
    heat: heatIndex({ fees24hUsd: nativeUsd(extras.fees24hWei, a.chain, prices), volume24hUsd: a.volume24hUsd }),
    agentState: agentState(a.status, a.jobs[0]),
    liveVersion: a.liveVersion,
    liveUrl: SERVABLE[a.status] && a.liveVersion > 0 ? liveUrl(a.slug) : null,
    screenshotUrl: SERVABLE[a.status] && a.liveVersion > 0 ? `${liveUrl(a.slug)}/_pyre/screenshots/home.png` : null,
    launcher: userRef(a.launcher),
    createdAt: a.createdAt.toISOString(),
    launchedAt: iso(a.launchedAt),
    graduatedAt: iso(a.graduatedAt),
    launchpadUrl: a.tokenAddress ? link.launchpad(a.tokenAddress) : null,
    explorerUrl: a.tokenAddress ? link.token(a.tokenAddress) : null,
  };
};

/* ─────────────────────────── Money rows ─────────────────────────── */

export const feeEventDto = (f: FeeEvent): FeeEventDto => ({
  id: f.id,
  source: f.source,
  wei: big(f.wei).toString(),
  ethPriceUsd: f.ethPriceUsd,
  usdMicros: f.usdMicros.toString(),
  buildMicros: f.buildMicros.toString(),
  pyreMicros: f.pyreMicros.toString(),
  coinBurnMicros: f.coinBurnMicros.toString(),
  launcherMicros: f.launcherMicros.toString(),
  upstreamMicros: f.upstreamMicros.toString(),
  creditsMicros: f.creditsMicros.toString(),
  txHash: f.txHash,
  createdAt: f.createdAt.toISOString(),
});

/** A settled (or in-flight) $PYRE burn; `createdAt` is the settlement time once BURNED. */
export const pyreBurnDto = (b: PyreBurn): PyreBurnDto => {
  const units = big(b.burnedUnits ?? b.tokensBurned);
  return {
    id: b.id,
    usdMicros: b.usdMicros.toString(),
    ethWei: big(b.ethWei).toString(),
    tokensBoughtUnits: big(b.tokensBought).toString(),
    burnedUnits: units.toString(),
    burnedPctOfSupply: pctOfSupply(units),
    swapTx: b.swapTx as PyreBurnDto["swapTx"],
    burnTx: b.burnTx as PyreBurnDto["burnTx"],
    attestTx: b.attestTx as PyreBurnDto["attestTx"],
    attestHash: b.attestHash,
    createdAt: (b.completedAt ?? b.createdAt).toISOString(),
  };
};

/** A settled (or in-flight) coin burn on a Solana app; `createdAt` is the settlement time once BURNED. */
export const coinBurnDto = (b: CoinBurn, app: VenueRow): CoinBurnDto => {
  const units = big(b.burnedUnits ?? b.tokensBurned);
  return {
    id: b.id,
    appId: b.appId,
    usdMicros: b.usdMicros.toString(),
    nativeWei: big(b.nativeWei).toString(),
    tokensBoughtUnits: big(b.tokensBought).toString(),
    burnedUnits: units.toString(),
    burnedPctOfSupply: pctOfSupply(units, metaOf(app).totalSupplyUnits),
    swapTx: b.swapTx,
    burnTx: b.burnTx,
    attestTx: b.attestTx,
    attestHash: b.attestHash,
    createdAt: (b.completedAt ?? b.createdAt).toISOString(),
  };
};

export const tradeDto = (t: Trade): TradeDto => ({
  id: t.id,
  appId: t.appId,
  side: t.side === "SELL" ? "SELL" : "BUY",
  venue: t.venue === "POOL" ? "POOL" : "CURVE",
  wallet: t.wallet,
  tokenUnits: big(t.tokenUnits).toString(),
  quoteWei: big(t.quoteWei).toString(),
  priceUsd: t.priceUsd,
  txHash: t.txHash,
  block: Number(t.block),
  ts: t.ts.toISOString(),
});

export const candleDto = (c: Candle): CandleDto => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });

export interface HolderRowInput {
  wallet: string;
  amount: Decimalish;
  /** Indexer-assigned protocol tag (Solana rows); absent/null for EVM rows, which are tagged by address here. */
  tag?: string | null;
}

/** Lower-cased protocol addresses → tag, computed once (env overrides are read at boot). */
const systemTags = (): Record<string, HolderDto["tag"]> => {
  const pons = ponsAddresses();
  return {
    [DEAD_ADDRESS.toLowerCase()]: "dead",
    [pons.poolManager.toLowerCase()]: "pool",
    [pons.locker.toLowerCase()]: "locker",
    [pons.buybackVault.toLowerCase()]: "vault",
    [TREASURY_WALLET.toLowerCase()]: "treasury",
  };
};
let SYSTEM_TAGS: Record<string, HolderDto["tag"]> | undefined;

/** Indexer tags (`VenueHolder.system`) → DTO tags. */
const INDEXER_TAGS: Record<string, HolderDto["tag"]> = { liquidity: "liquidity", locked: "locker", dead: "dead", vault: "vault" };

export interface HolderContext extends VenueRow {
  curveAddress: string | null;
  /** Launcher's custodial wallet on the app's chain. */
  launcherWallet: string | null;
}

export const holderDto = (h: HolderRowInput, ctx: HolderContext): HolderDto => {
  SYSTEM_TAGS ??= systemTags();
  const w = h.wallet.toLowerCase();
  const treasury = ctx.chain === "solana" ? adapterOf(ctx).treasury().address : TREASURY_WALLET;
  const tag: HolderDto["tag"] =
    (h.tag ? INDEXER_TAGS[h.tag] : undefined) ??
    (ctx.chain === "robinhood" ? SYSTEM_TAGS[w] : undefined) ??
    (ctx.curveAddress && w === ctx.curveAddress.toLowerCase()
      ? "curve"
      : w === treasury.toLowerCase()
        ? "treasury"
        : ctx.launcherWallet && w === ctx.launcherWallet.toLowerCase()
          ? "launcher"
          : null);
  const amount = big(h.amount);
  return { address: h.wallet, units: amount.toString(), pct: pctOfSupply(amount, metaOf(ctx).totalSupplyUnits), tag };
};

/* ─────────────────────────── Governance / community ─────────────────────────── */

export const queueItemDto = (
  q: PromptQueueItem & { author: UserRefRow; _count: { votes: number } },
  votedByMe: boolean,
): QueueItemDto => ({
  id: q.id,
  text: q.text,
  status: q.status,
  weightUnits: big(q.weight).toString(),
  weightPctOfSupply: pctOfSupply(big(q.weight)),
  votes: q._count.votes,
  votedByMe,
  author: userRef(q.author),
  jobId: q.jobId,
  createdAt: q.createdAt.toISOString(),
});

export const bountyDto = (b: Bounty & { author: UserRefRow; claimant?: UserRefRow | null }): BountyDto => ({
  id: b.id,
  appId: b.appId,
  title: b.title,
  description: b.description,
  wei: big(b.wei).toString(),
  status: b.status,
  author: userRef(b.author),
  claimant: b.claimant ? userRef(b.claimant) : null,
  prNumber: b.prNumber,
  escrowTx: b.escrowTx as BountyDto["escrowTx"],
  payoutTx: b.payoutTx as BountyDto["payoutTx"],
  createdAt: b.createdAt.toISOString(),
  claimedAt: iso(b.claimedAt),
});

export const prDto = (p: PullRequest): PullRequestDto => ({
  id: p.id,
  number: p.number,
  title: p.title,
  url: p.url,
  authorLogin: p.authorLogin,
  status: p.status,
  reviewSummary: p.reviewSummary,
  mergeSha: p.mergeSha,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const proposalDto = (
  p: Proposal & { author: UserRefRow },
  tally: { weight: bigint; votes: number; comments: number },
  votedByMe: boolean,
): ProposalDto => ({
  id: p.id,
  title: p.title,
  body: p.body,
  status: p.status,
  ownerNote: p.ownerNote,
  author: userRef(p.author),
  weightUnits: tally.weight.toString(),
  weightPctOfSupply: pctOfSupply(tally.weight),
  backed: tally.weight >= PLATFORM_PROPOSAL_QUORUM,
  votes: tally.votes,
  comments: tally.comments,
  votedByMe,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const notificationDto = (n: Notification): NotificationDto => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  href: n.href,
  readAt: iso(n.readAt),
  createdAt: n.createdAt.toISOString(),
});

export const stakeDto = (s: PyreStake, app: Pick<App, "slug" | "name" | "ticker"> | null | undefined): PyreStakeDto => ({
  id: s.id,
  appId: s.appId,
  appSlug: app?.slug ?? "",
  appName: app?.name ?? "",
  appTicker: app?.ticker ?? "",
  wallet: s.wallet as Address,
  units: big(s.amount).toString(),
  earnedMicros: s.earnedMicros.toString(),
  depositTx: s.depositTx as PyreStakeDto["depositTx"],
  withdrawTx: s.withdrawTx as PyreStakeDto["withdrawTx"],
  createdAt: s.createdAt.toISOString(),
  withdrawnAt: iso(s.withdrawnAt),
});

/* ─────────────────────────── Launch wizard ─────────────────────────── */

export const launchDto = (a: App): LaunchDraftDto => ({
  id: a.id,
  slug: a.slug,
  name: a.name,
  ticker: a.ticker,
  imageUrl: a.imageUrl,
  prompt: a.prompt,
  status: a.status,
  killedReason: a.killedReason,
  spec: AppSpec.safeParse(a.spec).success ? (a.spec as LaunchDraftDto["spec"]) : null,
  specApprovedAt: iso(a.specApprovedAt),
  template: a.template,
  chain: a.chain,
  launchpad: a.launchpad,
  native: VENUES[a.launchpad].native,
  walletAddress: a.walletAddress,
  tokenAddress: a.tokenAddress,
  curveAddress: a.curveAddress,
  launchTx: a.launchTx,
  stakeWei: big(a.stakeWei).toString(),
  stakeTx: a.stakeTx,
  stakeRefundTx: a.stakeRefundTx,
  stakeRefundedAt: iso(a.stakeRefundedAt),
  requiredStakeWei: requiredStake(a.chain).toString(),
  stakeTo: a.chain === "robinhood" ? TREASURY_WALLET : adapterOf(a).treasury().address,
  budgetMicros: a.budgetMicros.toString(),
  feesWei: big(a.feesWei).toString(),
  liveVersion: a.liveVersion,
  liveUrl: SERVABLE[a.status] && a.liveVersion > 0 ? liveUrl(a.slug) : null,
  twitterUrl: a.twitterUrl,
  websiteUrl: a.websiteUrl,
  forkOfId: a.forkOfId,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
});

export const adminJobDto = (j: BuildJob & { app: Pick<App, "slug" | "ticker"> }) => ({
  id: j.id,
  appId: j.appId,
  appSlug: j.app.slug,
  appTicker: j.app.ticker,
  stage: j.stage,
  status: j.status,
  model: j.model,
  budgetMicros: j.budgetMicros.toString(),
  costMicros: j.costMicros.toString(),
  sandboxId: j.sandboxId,
  error: j.error,
  startedAt: iso(j.startedAt),
  finishedAt: iso(j.finishedAt),
  createdAt: j.createdAt.toISOString(),
});
