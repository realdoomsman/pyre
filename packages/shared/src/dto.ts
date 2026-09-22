/**
 * Public API DTOs (API → web). One source of truth for the JSON the web client renders; the API
 * builds these in `apps/api/src/lib/dto.ts` and the web imports the types only.
 *
 * Amount semantics: USD = micros (1e6 = $1), ETH = wei, tokens = 1e18 base units, USDG = 1e6 units.
 * Every bigint travels as a decimal string (`BigIntString`); display-precision numbers (`priceUsd`,
 * `mcapUsd`, `heat`, percentages) are plain JSON numbers. Timestamps are ISO-8601 strings.
 */
import { z } from "zod";
import { EvmAddress, LaunchPhase, TxHash, AppSpec, BuildEventPayload } from "./schemas.js";
import { Chain, Launchpad, NativeAsset } from "./venues.js";

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

export const AppSort = z.enum(["trending", "new", "heating", "graduated", "shipping"]);
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
  /** Venue: every `…Wei` field below is in `native` base units (wei on Robinhood Chain, lamports on Solana). */
  chain: Chain,
  launchpad: Launchpad,
  native: NativeAsset,
  /** Venue-formatted (0x… on Robinhood Chain, base58 on Solana). */
  tokenAddress: z.string().nullable(),
  curveAddress: z.string().nullable(),
  /** Uniswap v4 poolId (bytes32) on Robinhood Chain; PumpSwap pool address on Solana. */
  poolId: z.string().nullable(),
  phase: LaunchPhase,
  /** Curve raise ÷ graduation threshold, 0..1; pinned to 1 once in the pool. */
  progress: z.number().min(0).max(1),
  priceUsd: z.number(),
  mcapUsd: z.number(),
  change24hPct: z.number().nullable(),
  volume24hUsd: z.number(),
  holders: z.number().int(),
  budgetMicros: BigIntString,
  feesWei: BigIntString,
  /** Heat index 0..1 — see `heatIndex` in apps/api/src/lib/dto.ts. */
  heat: z.number().min(0).max(1),
  agentState: AgentState,
  liveVersion: z.number().int(),
  liveUrl: z.string().nullable(),
  /** Latest verify-stage capture of the live deployment, served by the app host; null before the first deploy. */
  screenshotUrl: z.string().nullable(),
  launcher: UserRefDto,
  createdAt: IsoDate,
  launchedAt: IsoDate.nullable(),
  graduatedAt: IsoDate.nullable(),
  /** The coin's page on its launchpad (pons / pump.fun). */
  launchpadUrl: z.string().nullable(),
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


/** One fill on the curve or the pool. Mirrors the `Trade` table the runner's indexer fills. */
export const TradeDto = z.object({
  id: z.string(),
  appId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  /** Where the fill happened: the bonding curve (phase 0) or the graduated pool (phase 2). */
  venue: z.enum(["CURVE", "POOL"]),
  wallet: z.string(),
  tokenUnits: BigIntString,
  /** Native base units of the app's chain. */
  quoteWei: BigIntString,
  priceUsd: z.number(),
  txHash: z.string(),
  block: z.number().int(),
  ts: IsoDate,
});
export type TradeDto = z.infer<typeof TradeDto>;

export const HolderDto = z.object({
  address: z.string(),
  units: BigIntString,
  pct: z.number().min(0).max(100),
  /** Protocol-owned rows (curve, v4 pool, locker, buyback vault, burn sink, pump curve/pool liquidity) and the platform's own wallets; null for a plain holder. */
  tag: z.enum(["curve", "pool", "liquidity", "locker", "vault", "treasury", "launcher", "dead"]).nullable(),
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
  /** Native base units of the app's chain. */
  wei: BigIntString,
  /** Native/USD price at claim time (ETH on Robinhood Chain, SOL on Solana). */
  ethPriceUsd: z.number(),
  usdMicros: BigIntString,
  buildMicros: BigIntString,
  pyreMicros: BigIntString,
  /** The 25% burn leg off Robinhood Chain: buys and burns the coin itself. */
  coinBurnMicros: BigIntString,
  launcherMicros: BigIntString,
  upstreamMicros: BigIntString,
  creditsMicros: BigIntString,
  txHash: z.string().nullable(),
  createdAt: IsoDate,
});
export type FeeEventDto = z.infer<typeof FeeEventDto>;

/** One treasury buy-and-burn of a Solana coin (the 25% fee leg that would buy PYRE on Robinhood Chain), attested on chain. */
export const CoinBurnDto = z.object({
  id: z.string(),
  appId: z.string(),
  usdMicros: BigIntString,
  /** Lamports spent on the buy. */
  nativeWei: BigIntString,
  tokensBoughtUnits: BigIntString,
  burnedUnits: BigIntString,
  burnedPctOfSupply: z.number(),
  swapTx: z.string().nullable(),
  burnTx: z.string().nullable(),
  attestTx: z.string().nullable(),
  attestHash: z.string().nullable(),
  createdAt: IsoDate,
});
export type CoinBurnDto = z.infer<typeof CoinBurnDto>;

export const CoinBurnsPageDto = pageOf(CoinBurnDto);
export type CoinBurnsPageDto = z.infer<typeof CoinBurnsPageDto>;

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
  /** Creator/fee-recipient wallet on the app's chain (venue-formatted). */
  walletAddress: z.string().nullable(),
  stakeWei: BigIntString,
  stakeTx: z.string().nullable(),
  stakeRefundTx: z.string().nullable(),
  launchTx: z.string().nullable(),
  spentMicros: BigIntString,
  usersCount: z.number().int(),
  uptimeBps: z.number().int(),
  healthy: z.boolean(),
  /** Per-app wallet balances the fee sweeper will claim next: unswept on the curve/hook + escrow (creator vault on pump). */
  unsweptWei: BigIntString,
  escrowWei: BigIntString,
  /** Creator-fee split (bps) on the app's chain: 60/25 PYRE/15 on Robinhood Chain, 60/25 coin burn/15 on Solana. */
  feeSplit: z.object({ buildBudget: z.number().int(), pyreToken: z.number().int(), coinBurn: z.number().int(), launcher: z.number().int() }),
  graduationThresholdWei: BigIntString,
  /** Coin buy-and-burns from the app's own fees; null on Robinhood Chain where that leg burns PYRE instead. */
  coinBurns: z
    .object({
      count: z.number().int(),
      nativeWei: BigIntString,
      burnedUnits: BigIntString,
      burnedPctOfSupply: z.number(),
      /** `COINBURN:<appId>` ledger balance not yet burned. */
      pendingMicros: BigIntString,
      last: CoinBurnDto.nullable(),
    })
    .nullable(),
  /** Newest fee events first (build-budget history). */
  budgetHistory: z.array(FeeEventDto),
  lastBuild: BuildJobDto.nullable(),
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
 * the ETH/USD and SOL/USD prices and $PYRE's on-chain state. Written by the runner every price
 * pass so the API serves them from Postgres/Redis and never blocks a request on the RPC or a price feed.
 */
export const MarketSnapshot = z.object({
  ethPriceUsd: z.number().positive(),
  /** Null while the Solana venue is disabled. */
  solPriceUsd: z.number().positive().nullable().default(null),
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
  /** Lifetime creator fees claimed, per chain in that chain's native base units. */
  feesTotalWei: BigIntString,
  feesTotalLamports: BigIntString,
  burnedEthWei: BigIntString,
  burnedEth24hWei: BigIntString,
  burnedEth30dWei: BigIntString,
  /** Total rows each `GET /v1/apps?sort=` would return. */
  counts: z.record(AppSort, z.number().int()),
  pyreBurnsCount: z.number().int(),
  /** Agent compute hours in the current UTC day (from BuildJob runtimes). */
  agentHoursToday: z.number(),
  ethPriceUsd: z.number(),
  solPriceUsd: z.number().nullable(),
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
  /** Custodial Solana wallet balance; 0 while the Solana venue is disabled. */
  solLamports: BigIntString,
  solPriceUsd: z.number(),
});
export type BalancesDto = z.infer<typeof BalancesDto>;

export const PositionDto = z.object({
  app: AppSummaryDto,
  units: BigIntString,
  valueUsd: z.number(),
  /** Share of supply, 0..100. */
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
  /** Venue: `…Wei` fields are in `native` base units; addresses/hashes are venue-formatted. */
  chain: Chain,
  launchpad: Launchpad,
  native: NativeAsset,
  walletAddress: z.string().nullable(),
  tokenAddress: z.string().nullable(),
  curveAddress: z.string().nullable(),
  launchTx: z.string().nullable(),
  stakeWei: BigIntString,
  stakeTx: z.string().nullable(),
  stakeRefundTx: z.string().nullable(),
  stakeRefundedAt: IsoDate.nullable(),
  /** Fixed stake the launcher must post (`LAUNCH_STAKE_BY_CHAIN[chain]`). */
  requiredStakeWei: BigIntString,
  /** Where an external wallet sends the stake (the platform treasury on the app's chain). */
  stakeTo: z.string(),
  budgetMicros: BigIntString,
  feesWei: BigIntString,
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
  /** Custodial wallet on Robinhood Chain (server-signed). */
  wallet: EvmAddress,
  /** Custodial wallet on Solana (base58); null while the Solana venue is disabled. */
  solWallet: z.string().nullable(),
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
  /** Every `…Wei` figure below is in `native` base units of the coin's chain. */
  chain: Chain,
  native: NativeAsset,
  /** Exact amount in (native for buy, token units for sell). */
  amountIn: BigIntString,
  /** Expected amount out (token units for buy, native for sell). */
  amountOut: BigIntString,
  /** Out after the caller's slippage tolerance; the tx reverts below this. */
  minOut: BigIntString,
  /** Fee taken by the launchpad on this fill (native), including any early-buy snipe tax. */
  feeWei: BigIntString,
  snipeTaxBps: z.number().int(),
  /** Native refunded when a curve buy overshoots graduation (PONS only). */
  refundWei: BigIntString,
  priceImpactPct: z.number(),
  priceUsd: z.number(),
  nativePriceUsd: z.number(),
});
export type TradeQuoteDto = z.infer<typeof TradeQuoteDto>;

export const TradeResultDto = z.object({
  trade: TradeDto,
  quote: TradeQuoteDto,
  balances: BalancesDto,
});
export type TradeResultDto = z.infer<typeof TradeResultDto>;

export const WithdrawResultDto = z.object({
  asset: z.enum(["ETH", "USDG", "SOL"]),
  to: z.string(),
  amount: BigIntString,
  txHash: z.string(),
  explorerUrl: z.string(),
  balances: BalancesDto,
});
export type WithdrawResultDto = z.infer<typeof WithdrawResultDto>;

/* ─────────────────────────── Venues ─────────────────────────── */

/** One launch venue as the web sees it: enabled by the API's environment, stake in native base units. */
export const VenueDto = z.object({
  chain: Chain,
  launchpad: Launchpad,
  enabled: z.boolean(),
  stakeWei: BigIntString,
  chainLabel: z.string(),
  launchpadLabel: z.string(),
  native: NativeAsset,
  tokenDecimals: z.number().int(),
  /** Solana cluster the API runs against (for explorer links); null on EVM venues. */
  cluster: z.enum(["mainnet-beta", "devnet"]).nullable(),
});
export type VenueDto = z.infer<typeof VenueDto>;

export const VenuesDto = z.object({ venues: z.array(VenueDto) });
export type VenuesDto = z.infer<typeof VenuesDto>;

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
  /** Treasury Solana wallet; null while the Solana venue is disabled. */
  solana: z.object({ address: z.string(), lamports: BigIntString, cluster: z.enum(["mainnet-beta", "devnet"]), solPriceUsd: z.number(), rpcOk: z.boolean() }).nullable(),
  chain: z.object({ chainId: z.number().int(), blockNumber: z.number().int(), ethPriceUsd: z.number(), rpcOk: z.boolean() }),
  apps: z.record(z.string(), z.number().int()),
  jobs: z.object({ queued: z.number().int(), running: z.number().int(), failed24h: z.number().int(), succeeded24h: z.number().int() }),
  compute: z.object({ todayMicros: BigIntString, ceilingMicros: BigIntString }),
  money: z.object({
    /** Per chain, native base units. */
    feesTotalWei: BigIntString,
    fees24hWei: BigIntString,
    feesTotalLamports: BigIntString,
    fees24hLamports: BigIntString,
    pyreBurnsPending: z.number().int(),
    pyreBurnsStuck: z.number().int(),
    coinBurnsPending: z.number().int(),
    coinBurnsStuck: z.number().int(),
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

/** One treasury buy-and-burn of $PYRE (its 25% share of every coin's creator fees), attested on chain. */
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

/** Global burn ledger row: a PyreBurnDto plus running totals as of that row (newest first). */
export const BurnLedgerRowDto = PyreBurnDto.extend({
  cumulativeEthWei: BigIntString,
  cumulativeUsdMicros: BigIntString,
});
export type BurnLedgerRowDto = z.infer<typeof BurnLedgerRowDto>;

export const BurnsPageDto = z.object({
  items: z.array(BurnLedgerRowDto),
  nextCursor: z.string().nullable(),
  totals: z.object({
    ethWei: BigIntString,
    usdMicros: BigIntString,
    burns: z.number().int(),
  }),
});
export type BurnsPageDto = z.infer<typeof BurnsPageDto>;

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
  /** Ledger account PYRE_TOKEN: the 25% fee share accrued, and what was burned. */
  ledger: z.object({
    accruedMicros: BigIntString,
    burnedMicros: BigIntString,
    pendingMicros: BigIntString,
  }),
  feeShareBps: z.number().int(),
  stakes: z.object({ totalUnits: BigIntString, stakers: z.number().int(), earnedMicros: BigIntString }),
  /** $PYRE's own buy-and-burns (from the treasury), newest first. */
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

/**
 * Launch stake: an external-wallet transfer to verify, or a custodial debit. External stakes need
 * a wallet proven at login, which only exists on Robinhood Chain; Solana stakes are custodial.
 */
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
