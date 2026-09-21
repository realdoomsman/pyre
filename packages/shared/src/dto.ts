/**
 * Public API DTOs (API → web). One source of truth for the JSON the web client renders; the API
 * builds these in `apps/api/src/lib/dto.ts` and the web imports the types only.
 *
 * Amount semantics: USD = micros (1e6 = $1), ETH = wei, tokens = 1e18 base units, USDG = 1e6 units.
 * Every bigint travels as a decimal string (`BigIntString`); display-precision numbers (`priceUsd`,
 * `mcapUsd`, `heat`, percentages) are plain JSON numbers. Timestamps are ISO-8601 strings.
 */
import { z } from "zod";
import { EvmAddress, LaunchPhase, TxHash, AppSpec, BuildEventPayload, MonetizationModel } from "./schemas.js";

/* ─────────────────────────── Primitives ─────────────────────────── */

/** A bigint serialised as a decimal string ("0", "2000000000000000", "-5"). */
export const BigIntString = z.string().regex(/^-?\d+$/, "expected a decimal integer string");
export type BigIntString = z.infer<typeof BigIntString>;

export const IsoDate = z.string().datetime({ offset: true });

export const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const AppStatusDto = z.enum(["DRAFT", "SPEC_READY", "AWAITING_STAKE", "LAUNCHING", "LAUNCH_GATED", "LIVE", "DORMANT", "KILLED", "FAILED"]);
export type AppStatusDto = z.infer<typeof AppStatusDto>;

/** What the build agent is doing right now, derived from the newest BuildJob + app status. */
export const AgentState = z.enum(["idle", "building", "reviewing", "deploying", "dormant"]);
export type AgentState = z.infer<typeof AgentState>;

export const AppSort = z.enum(["trending", "new", "heating", "graduated", "shipping", "burning", "revenue"]);
export type AppSort = z.infer<typeof AppSort>;

export const CandleIntervalDto = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);
export type CandleIntervalDto = z.infer<typeof CandleIntervalDto>;

export const UserRefDto = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  wallet: EvmAddress.nullable(),
  xHandle: z.string().nullable(),
});
export type UserRefDto = z.infer<typeof UserRefDto>;

/** Cursor-paginated list envelope. `nextCursor` is opaque; null = last page. */
export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/* ─────────────────────────── Apps / coins ─────────────────────────── */

export const AppSummaryDto = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  ticker: z.string(),
  imageUrl: z.string(),
  oneLiner: z.string(),
  status: AppStatusDto,
  template: z.enum(["WEB_TOOL", "GAME", "AGENT_API"]),
  monetization: MonetizationModel.nullable(),
  tokenAddress: EvmAddress.nullable(),
  curveAddress: EvmAddress.nullable(),
  poolId: Bytes32.nullable(),
  phase: LaunchPhase,
  /** Curve raise ÷ graduation threshold, 0..1; pinned to 1 once in the pool. */
  progress: z.number().min(0).max(1),
  priceUsd: z.number(),
  mcapUsd: z.number(),
  change24hPct: z.number().nullable(),
  volume24hUsd: z.number(),
  holders: z.number().int(),
  revenueMicros: BigIntString,
  revenue24hMicros: BigIntString,
  budgetMicros: BigIntString,
  feesWei: BigIntString,
  buybackWei: BigIntString,
  burnedUnits: BigIntString,
  /** Burned ÷ PONS_TOTAL_SUPPLY, 0..100. */
  burnedPct: z.number().min(0).max(100),
  /** Heat index 0..1 — see `heatIndex` in apps/api/src/lib/dto.ts. */
  heat: z.number().min(0).max(1),
  agentState: AgentState,
  liveVersion: z.number().int(),
  liveUrl: z.string().nullable(),
  launcher: UserRefDto,
  createdAt: IsoDate,
  launchedAt: IsoDate.nullable(),
  graduatedAt: IsoDate.nullable(),
  ponsUrl: z.string().nullable(),
  explorerUrl: z.string().nullable(),
});
export type AppSummaryDto = z.infer<typeof AppSummaryDto>;

export const BuildJobDto = z.object({
  id: z.string(),
  stage: z.string(),
  status: z.string(),
  model: z.string().nullable(),
  budgetMicros: BigIntString,
  costMicros: BigIntString,
  summary: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type BuildJobDto = z.infer<typeof BuildJobDto>;

export const BuildEventDto = z.object({
  id: z.string(),
  appId: z.string(),
  jobId: z.string().nullable(),
  type: z.string(),
  payload: BuildEventPayload,
  createdAt: IsoDate,
});
export type BuildEventDto = z.infer<typeof BuildEventDto>;

export const BuybackDto = z.object({
  id: z.string(),
  appId: z.string(),
  slug: z.string(),
  ticker: z.string(),
  status: z.enum(["PENDING", "SWAPPING", "SWAPPED", "BURNED", "FAILED"]),
  revenueMicros: BigIntString,
  ethWei: BigIntString,
  tokensBoughtUnits: BigIntString,
  tokensBurnedUnits: BigIntString,
  burnedPctOfSupply: z.number().min(0).max(100),
  swapTx: TxHash.nullable(),
  burnTx: TxHash.nullable(),
  attestTx: TxHash.nullable(),
  attestHash: z.string(),
  revenueEventIds: z.number().int(),
  createdAt: IsoDate,
  completedAt: IsoDate.nullable(),
});
export type BuybackDto = z.infer<typeof BuybackDto>;

/** Global burn ledger row: a BuybackDto plus running totals as of that row (newest first). */
export const BurnLedgerRowDto = BuybackDto.extend({
  cumulativeEthWei: BigIntString,
  cumulativeRevenueMicros: BigIntString,
});
export type BurnLedgerRowDto = z.infer<typeof BurnLedgerRowDto>;

export const BurnsPageDto = z.object({
  items: z.array(BurnLedgerRowDto),
  nextCursor: z.string().nullable(),
  totals: z.object({
    ethWei: BigIntString,
    revenueMicros: BigIntString,
    buybacks: z.number().int(),
    coins: z.number().int(),
  }),
});
export type BurnsPageDto = z.infer<typeof BurnsPageDto>;

/** One fill on the curve or the v4 pool. Mirrors the `Trade` table the runner's indexer fills. */
export const TradeDto = z.object({
  id: z.string(),
  appId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  /** Where the fill happened: the bonding curve (phase 0) or the Uniswap v4 pool (phase 2). */
  venue: z.enum(["CURVE", "POOL"]),
  wallet: EvmAddress,
  tokenUnits: BigIntString,
  quoteWei: BigIntString,
  priceUsd: z.number(),
  txHash: TxHash,
  block: z.number().int(),
  /** True when the platform's buyback executor was the trader. */
  isBuyback: z.boolean(),
  ts: IsoDate,
});
export type TradeDto = z.infer<typeof TradeDto>;

export const HolderDto = z.object({
  address: EvmAddress,
  units: BigIntString,
  pct: z.number().min(0).max(100),
  /** Protocol-owned rows (curve, v4 pool, locker, buyback vault, burn sink) and the platform's own wallets; null for a plain holder. */
  tag: z.enum(["curve", "pool", "locker", "vault", "treasury", "launcher", "dead"]).nullable(),
});
export type HolderDto = z.infer<typeof HolderDto>;

export const CandleDto = z.object({
  /** Unix seconds, bucket open. */
  t: z.number().int(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  /** USD volume (display number). */
  v: z.number(),
});
export type CandleDto = z.infer<typeof CandleDto>;

export const CandlesDto = z.object({
  interval: CandleIntervalDto,
  /** Prices quoted in USD per token; multiply by `supply` for market cap. */
  candles: z.array(CandleDto),
  /** Circulating supply (display tokens) used for the MCap toggle. */
  supply: z.number(),
  /** Burn markers for the chart (unix seconds + burned units). */
  burns: z.array(z.object({ t: z.number().int(), units: BigIntString, txHash: TxHash.nullable() })),
});
export type CandlesDto = z.infer<typeof CandlesDto>;

export const ProposalDto = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.enum(["OPEN", "PLANNED", "BUILDING", "SHIPPED", "DECLINED"]),
  ownerNote: z.string().nullable(),
  author: UserRefDto,
  weightUnits: BigIntString,
  weightPctOfSupply: z.number(),
  backed: z.boolean(),
  votes: z.number().int(),
  comments: z.number().int(),
  votedByMe: z.boolean(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type ProposalDto = z.infer<typeof ProposalDto>;

export const QueueItemDto = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["OPEN", "SCHEDULED", "DONE", "REJECTED"]),
  weightUnits: BigIntString,
  weightPctOfSupply: z.number(),
  votes: z.number().int(),
  votedByMe: z.boolean(),
  author: UserRefDto,
  jobId: z.string().nullable(),
  createdAt: IsoDate,
});
export type QueueItemDto = z.infer<typeof QueueItemDto>;

export const BountyDto = z.object({
  id: z.string(),
  appId: z.string(),
  title: z.string(),
  description: z.string(),
  wei: BigIntString,
  status: z.enum(["OPEN", "CLAIMED", "PAYING", "PAID", "CANCELLED"]),
  author: UserRefDto,
  claimant: UserRefDto.nullable(),
  prNumber: z.number().int().nullable(),
  escrowTx: TxHash,
  payoutTx: TxHash.nullable(),
  createdAt: IsoDate,
  claimedAt: IsoDate.nullable(),
});
export type BountyDto = z.infer<typeof BountyDto>;

export const PullRequestDto = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  authorLogin: z.string(),
  status: z.enum(["OPEN", "REVIEWING", "APPROVED", "REJECTED", "MERGED"]),
  reviewSummary: z.string().nullable(),
  mergeSha: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type PullRequestDto = z.infer<typeof PullRequestDto>;

export const FeeEventDto = z.object({
  id: z.string(),
  source: z.enum(["CREATOR_FEE", "FORK_ROYALTY", "REVIVE_BUY", "MANUAL"]),
  wei: BigIntString,
  ethPriceUsd: z.number(),
  usdMicros: BigIntString,
  buildMicros: BigIntString,
  pyreMicros: BigIntString,
  launcherMicros: BigIntString,
  upstreamMicros: BigIntString,
  creditsMicros: BigIntString,
  txHash: TxHash.nullable(),
  createdAt: IsoDate,
});
export type FeeEventDto = z.infer<typeof FeeEventDto>;

export const RevenueEventDto = z.object({
  id: z.string(),
  source: z.enum(["CHECKOUT", "SUBSCRIPTION", "X402", "AD", "EXTERNAL_SDK"]),
  usdMicros: BigIntString,
  reference: z.string().nullable(),
  buybackId: z.string().nullable(),
  createdAt: IsoDate,
});
export type RevenueEventDto = z.infer<typeof RevenueEventDto>;

export const AppSocialsDto = z.object({
  twitter: z.string().nullable(),
  website: z.string().nullable(),
  xAccount: z.string().nullable(),
  repoUrl: z.string().nullable(),
});
export type AppSocialsDto = z.infer<typeof AppSocialsDto>;

export const AppDetailDto = AppSummaryDto.extend({
  spec: AppSpec.nullable(),
  prompt: z.string(),
  killedReason: z.string().nullable(),
  walletAddress: EvmAddress.nullable(),
  stakeWei: BigIntString,
  stakeTx: TxHash.nullable(),
  stakeRefundTx: TxHash.nullable(),
  launchTx: TxHash.nullable(),
  spentMicros: BigIntString,
  pendingRevenueMicros: BigIntString,
  usersCount: z.number().int(),
  uptimeBps: z.number().int(),
  healthy: z.boolean(),
  /** Per-app wallet balances the fee sweeper will claim next: unswept on the curve/hook + escrow. */
  unsweptWei: BigIntString,
  escrowWei: BigIntString,
  /** 60/25/15 creator-fee split (bps). */
  feeSplit: z.object({ buildBudget: z.number().int(), pyreToken: z.number().int(), launcher: z.number().int() }),
  /** 85/10/5 app-revenue split (bps). */
  revenueSplit: z.object({ buybackBurn: z.number().int(), pyreToken: z.number().int(), platformOps: z.number().int() }),
  graduationThresholdWei: BigIntString,
  /** Newest fee events first (build-budget history). */
  budgetHistory: z.array(FeeEventDto),
  lastBuild: BuildJobDto.nullable(),
  lastBuyback: BuybackDto.nullable(),
  lastEvent: BuildEventDto.nullable(),
  roadmap: z.object({ open: z.number().int(), scheduled: z.number().int(), done: z.number().int(), top: z.array(QueueItemDto) }),
  bounties: z.object({ open: z.number().int(), openWei: BigIntString }),
  socials: AppSocialsDto,
  forkOf: z.object({ id: z.string(), slug: z.string(), name: z.string(), ticker: z.string() }).nullable(),
  forks: z.number().int(),
  maintainer: UserRefDto.nullable(),
  milestones: z.array(z.string()),
  /** Present only for an authenticated viewer. */
  viewer: z
    .object({
      units: BigIntString,
      pctOfSupply: z.number(),
      isLauncher: z.boolean(),
      isContributor: z.boolean(),
      isMaintainer: z.boolean(),
    })
    .nullable(),
});
export type AppDetailDto = z.infer<typeof AppDetailDto>;

export const AppsPageDto = pageOf(AppSummaryDto);
export type AppsPageDto = z.infer<typeof AppsPageDto>;

/* ─────────────────────────── Market snapshot (runner → API) ─────────────────────────── */

/** `PlatformSetting.key` under which the runner's price pass stores `MarketSnapshot`. */
export const MARKET_SNAPSHOT_KEY = "market:snapshot";

/**
 * Platform-wide market figures the public read paths need (`/v1/stats`, `/v1/pyre`, app pages):
 * the ETH/USD price and $PYRE's on-chain state. Written by the runner every price pass so the API
 * serves them from Postgres/Redis and never blocks a request on the RPC or a price feed.
 */
export const MarketSnapshot = z.object({
  ethPriceUsd: z.number().positive(),
  pyreToken: z
    .object({
      address: EvmAddress,
      name: z.string(),
      symbol: z.string(),
      phase: LaunchPhase,
      curveAddress: EvmAddress,
      poolId: z.string(),
      progress: z.number(),
      priceUsd: z.number(),
      priceEth: z.number(),
      mcapUsd: z.number(),
      totalSupplyUnits: BigIntString,
      burnedUnits: BigIntString,
    })
    .nullable(),
  updatedAt: IsoDate,
});
export type MarketSnapshot = z.infer<typeof MarketSnapshot>;

/* ─────────────────────────── Stats ─────────────────────────── */

export const StatsDto = z.object({
  appsLive: z.number().int(),
  appsBuilding: z.number().int(),
  appsTotal: z.number().int(),
  revenueTotalMicros: BigIntString,
  revenue24hMicros: BigIntString,
  feesTotalWei: BigIntString,
  burnedEthWei: BigIntString,
  burnedEth24hWei: BigIntString,
  burnedEth30dWei: BigIntString,
  revenue30dMicros: BigIntString,
  /** Total rows each `GET /v1/apps?sort=` would return. */
  counts: z.record(AppSort, z.number().int()),
  buybacksCount: z.number().int(),
  /** Agent compute hours in the current UTC day (from BuildJob runtimes). */
  agentHoursToday: z.number(),
  ethPriceUsd: z.number(),
  pyreToken: z
    .object({
      address: EvmAddress,
      priceUsd: z.number(),
      mcapUsd: z.number(),
      burnedUnits: BigIntString,
      burnedPct: z.number(),
    })
    .nullable(),
  updatedAt: IsoDate,
});
export type StatsDto = z.infer<typeof StatsDto>;

/* ─────────────────────────── Me ─────────────────────────── */

export const BalancesDto = z.object({
  ethWei: BigIntString,
  usdgUnits: BigIntString,
  ethPriceUsd: z.number(),
});
export type BalancesDto = z.infer<typeof BalancesDto>;

export const PositionDto = z.object({
  app: AppSummaryDto,
  units: BigIntString,
  valueUsd: z.number(),
  /** Share of remaining (unburned) supply, 0..100. */
  shareOfRemainingPct: z.number(),
});
export type PositionDto = z.infer<typeof PositionDto>;

export const LaunchDraftDto = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  ticker: z.string(),
  imageUrl: z.string(),
  prompt: z.string(),
  status: AppStatusDto,
  killedReason: z.string().nullable(),
  spec: AppSpec.nullable(),
  specApprovedAt: IsoDate.nullable(),
  template: z.enum(["WEB_TOOL", "GAME", "AGENT_API"]),
  walletAddress: EvmAddress.nullable(),
  tokenAddress: EvmAddress.nullable(),
  curveAddress: EvmAddress.nullable(),
  launchTx: TxHash.nullable(),
  stakeWei: BigIntString,
  stakeTx: TxHash.nullable(),
  stakeRefundTx: TxHash.nullable(),
  stakeRefundedAt: IsoDate.nullable(),
  /** Fixed stake the launcher must post (LAUNCH_STAKE_WEI). */
  requiredStakeWei: BigIntString,
  /** Where an external wallet sends the stake (the platform treasury). */
  stakeTo: EvmAddress,
  budgetMicros: BigIntString,
  feesWei: BigIntString,
  revenueMicros: BigIntString,
  liveVersion: z.number().int(),
  liveUrl: z.string().nullable(),
  twitterUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  forkOfId: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type LaunchDraftDto = z.infer<typeof LaunchDraftDto>;

export const NotificationDto = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  href: z.string().nullable(),
  readAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type NotificationDto = z.infer<typeof NotificationDto>;

export const MeDto = z.object({
  user: z.object({
    id: z.string(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    xHandle: z.string().nullable(),
    isAdmin: z.boolean(),
    reputation: z.number().int(),
    tier: z.enum(["NEW", "TRUSTED", "VETERAN"]),
    createdAt: IsoDate,
  }),
  /** Custodial wallet (server-signed). */
  wallet: EvmAddress,
  /** External wallet proved at login, if the user signed in with one. */
  authWallet: EvmAddress.nullable(),
  balances: BalancesDto,
  positions: z.array(PositionDto),
  launched: z.array(LaunchDraftDto),
  claimable: z.object({ launcherMicros: BigIntString, launcherWei: BigIntString, stakerMicros: BigIntString }),
  launchesToday: z.number().int(),
  launchLimitPerDay: z.number().int(),
  notifications: z.object({ unread: z.number().int() }),
  /** Daily withdrawal headroom in USD micros. */
  withdrawRemainingMicros: BigIntString,
});
export type MeDto = z.infer<typeof MeDto>;

export const TradeQuoteDto = z.object({
  slug: z.string(),
  side: z.enum(["buy", "sell"]),
  venue: z.enum(["CURVE", "POOL"]),
  phase: LaunchPhase,
  /** Exact amount in (wei for buy, token units for sell). */
  amountIn: BigIntString,
  /** Expected amount out (token units for buy, wei for sell). */
  amountOut: BigIntString,
  /** Out after the caller's slippage tolerance; the tx reverts below this. */
  minOut: BigIntString,
  /** Protocol fee taken by PONS on this fill (wei), including any early-buy snipe tax. */
  feeWei: BigIntString,
  snipeTaxBps: z.number().int(),
  /** Wei refunded when a curve buy overshoots graduation. */
  refundWei: BigIntString,
  priceImpactPct: z.number(),
  priceUsd: z.number(),
  ethPriceUsd: z.number(),
});
export type TradeQuoteDto = z.infer<typeof TradeQuoteDto>;

export const TradeResultDto = z.object({
  trade: TradeDto,
  quote: TradeQuoteDto,
  balances: BalancesDto,
});
export type TradeResultDto = z.infer<typeof TradeResultDto>;

export const WithdrawResultDto = z.object({
  asset: z.enum(["ETH", "USDG"]),
  to: EvmAddress,
  amount: BigIntString,
  txHash: TxHash,
  explorerUrl: z.string(),
  balances: BalancesDto,
});
export type WithdrawResultDto = z.infer<typeof WithdrawResultDto>;

/* ─────────────────────────── Ops ─────────────────────────── */

export const OpsAlertDto = z.object({
  level: z.enum(["info", "warn", "critical"]),
  code: z.string(),
  message: z.string(),
  href: z.string().nullable(),
});
export type OpsAlertDto = z.infer<typeof OpsAlertDto>;

export const OpsDto = z.object({
  generatedAt: IsoDate,
  treasury: z.object({ address: EvmAddress, ethWei: BigIntString, usdgUnits: BigIntString }),
  chain: z.object({ chainId: z.number().int(), blockNumber: z.number().int(), ethPriceUsd: z.number(), rpcOk: z.boolean() }),
  apps: z.record(z.string(), z.number().int()),
  jobs: z.object({ queued: z.number().int(), running: z.number().int(), failed24h: z.number().int(), succeeded24h: z.number().int() }),
  compute: z.object({ todayMicros: BigIntString, ceilingMicros: BigIntString }),
  money: z.object({
    feesTotalWei: BigIntString,
    fees24hWei: BigIntString,
    revenueTotalMicros: BigIntString,
    revenue24hMicros: BigIntString,
    buybacksPending: z.number().int(),
    buybacksStuck: z.number().int(),
    creditFundingsStuck: z.number().int(),
    ledger: z.record(z.string(), BigIntString),
  }),
  flags: z.object({ open: z.number().int(), reportsOpen: z.number().int() }),
  settings: z.record(z.string(), z.unknown()),
  reconcile: z.array(
    z.object({ kind: z.string(), ok: z.boolean(), drifted: z.number().int(), checked: z.number().int(), createdAt: IsoDate }),
  ),
  alerts: z.array(OpsAlertDto),
});
export type OpsDto = z.infer<typeof OpsDto>;

/* ─────────────────────────── $PYRE ─────────────────────────── */

/** One treasury buy-and-burn of $PYRE (its 25% fee share + 10% revenue share), attested on chain. */
export const PyreBurnDto = z.object({
  id: z.string(),
  usdMicros: BigIntString,
  ethWei: BigIntString,
  tokensBoughtUnits: BigIntString,
  burnedUnits: BigIntString,
  burnedPctOfSupply: z.number(),
  swapTx: TxHash.nullable(),
  burnTx: TxHash.nullable(),
  attestTx: TxHash.nullable(),
  attestHash: z.string().nullable(),
  createdAt: IsoDate,
});
export type PyreBurnDto = z.infer<typeof PyreBurnDto>;

/** One $PYRE stake on an app (custodial wallet → treasury stake vault). */
export const PyreStakeDto = z.object({
  id: z.string(),
  appId: z.string(),
  appSlug: z.string(),
  appName: z.string(),
  appTicker: z.string(),
  wallet: EvmAddress,
  units: BigIntString,
  earnedMicros: BigIntString,
  depositTx: TxHash,
  withdrawTx: TxHash.nullable(),
  createdAt: IsoDate,
  withdrawnAt: IsoDate.nullable(),
});
export type PyreStakeDto = z.infer<typeof PyreStakeDto>;

export const PyrePageDto = z.object({
  launched: z.boolean(),
  token: z
    .object({
      address: EvmAddress,
      name: z.string(),
      symbol: z.string(),
      phase: LaunchPhase,
      curveAddress: EvmAddress.nullable(),
      poolId: Bytes32.nullable(),
      progress: z.number().min(0).max(1),
      priceUsd: z.number(),
      priceEth: z.number(),
      mcapUsd: z.number(),
      totalSupplyUnits: BigIntString,
      burnedUnits: BigIntString,
      burnedPct: z.number(),
      ponsUrl: z.string(),
      explorerUrl: z.string(),
    })
    .nullable(),
  /** Ledger account PYRE_TOKEN: fee share (25%) + revenue share (10%) accrued, and what was burned. */
  ledger: z.object({
    accruedMicros: BigIntString,
    burnedMicros: BigIntString,
    pendingMicros: BigIntString,
  }),
  feeShareBps: z.number().int(),
  revenueShareBps: z.number().int(),
  stakes: z.object({ totalUnits: BigIntString, stakers: z.number().int(), earnedMicros: BigIntString }),
  /** $PYRE's own buy-and-burns (from the treasury; no per-app Buyback row), newest first. */
  burns: z.array(PyreBurnDto),
  proposals: z.object({ open: z.number().int(), shipped: z.number().int() }),
  topStakes: z.array(z.object({ appId: z.string(), appSlug: z.string(), appName: z.string(), appTicker: z.string(), units: BigIntString, stakers: z.number().int() })),
  viewer: z
    .object({
      units: BigIntString,
      stakedUnits: BigIntString,
      earnedMicros: BigIntString,
      canPropose: z.boolean(),
      stakes: z.array(PyreStakeDto),
    })
    .nullable(),
});
export type PyrePageDto = z.infer<typeof PyrePageDto>;

/* ─────────────────────────── Request bodies (web → API) ─────────────────────────── */

export const WalletChallengeBody = z.object({ address: EvmAddress });
export const WalletVerifyBody = z.object({ address: EvmAddress, signature: z.string().regex(/^0x[0-9a-fA-F]+$/) });

/** Launch stake: an external-wallet transfer to verify, or a custodial debit. */
export const StakeBody = z.union([z.object({ txHash: TxHash }), z.object({ custodial: z.literal(true) })]);
export type StakeBody = z.infer<typeof StakeBody>;

/** A non-negative bigint as a decimal string: user-supplied on-chain amounts are never signed. */
export const UnsignedBigIntString = z.string().regex(/^\d+$/, "expected a non-negative decimal integer string");

export const TradeBody = z.object({
  slug: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  /** Wei for buy, token base units for sell. */
  amount: UnsignedBigIntString,
  /** Optional explicit floor; when omitted the server derives it from `slippageBps`. The server never accepts a floor below 50% slippage. */
  minOut: UnsignedBigIntString.optional(),
  slippageBps: z.number().int().min(1).max(5000).default(100),
});
export type TradeBody = z.infer<typeof TradeBody>;

export const RpcBody = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string(),
  params: z.array(z.unknown()).optional(),
});
export type RpcBody = z.infer<typeof RpcBody>;
