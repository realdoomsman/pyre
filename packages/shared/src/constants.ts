/**
 * Pyre economics. Every number that moves money lives here so the API, runner,
 * and web agree on a single source of truth. Percentages are in basis points.
 *
 * Amount semantics everywhere: USD = micros (bigint, 1e6 = $1), ETH = wei (bigint, 1e18 = 1 ETH),
 * launch tokens = base units (bigint, 1e18 = 1 token), USDG = 1e6 units.
 */

/** Robinhood Chain (Arbitrum Nitro L2, native ETH). */
export const ROBINHOOD_CHAIN_ID = 4663;

/** Creator-fee split (ETH claimed from the PONS v2 fee escrow). Sums to 10_000. */
export const FEE_SPLIT_BPS = {
  BUILD_BUDGET: 6000,
  PYRE_TOKEN: 2500,
  LAUNCHER: 1500,
} as const;

/** App revenue split. Sums to 10_000. */
export const REVENUE_SPLIT_BPS = {
  BUYBACK_BURN: 8500,
  PYRE_TOKEN: 1000,
  PLATFORM_OPS: 500,
} as const;

/** Forks route this share of their fees upstream to the original app, forever. */
export const FORK_ROYALTY_BPS = 1000;

/**
 * Share of the build-budget cut physically routed to the model-credit funding wallet — the card
 * that pays Anthropic. Carved out of the 60% build budget (like the fork royalty), so the headline
 * split becomes build / credits / $PYRE / launcher. At 5000 bps the credits routed equal the build
 * budget left spendable, so the card self-funds every dollar of compute an app is allowed to spend.
 * Set to 0 to keep 100% of the build cut as spendable budget (operator funds Anthropic out of band).
 */
export const CREDITS_FUNDING_BPS = 5000;

/** Minimum accrued, unfunded credits (USD) before an ETH→USDC→card top-up is worth its fees (also Zentro's minimum). */
export const MIN_CREDITS_FUNDING_USD = 15;

/** Minimum accrued build budget before the first build starts. */
export const MIN_BUILD_BUDGET_USD = 50;

/** Per-iteration hard cap paid to the agent runner. */
export const ITERATION_BUDGET_USD = { MIN: 10, DEFAULT: 25, MAX: 50 } as const;

/** Global daily platform compute ceiling (USD). Runner refuses new jobs past this. */
export const GLOBAL_DAILY_COMPUTE_CEILING_USD = 2000;

/** Refundable launch stake in wei (0.05 ETH, ≈$135). Spam control only; returned at first build threshold. */
export const LAUNCH_STAKE_WEI = 50_000_000_000_000_000n;

/** Tiny budget used for the intake spec generation before any coin exists. Paid by platform. */
export const SPEC_INTAKE_BUDGET_USD = 0.5;

/** Revenue milestones (USD). Each posts to feed + X automatically. */
export const REVENUE_MILESTONES_USD = [1, 1_000, 10_000, 100_000] as const;

/** Governance: token-weighted with per-wallet cap (share of circulating supply, bps). */
export const VOTE_WALLET_CAP_BPS = 200; // 2% of supply max weight per wallet
export const PROMPT_QUEUE_MIN_HOLD_BPS = 10; // hold ≥0.1% of supply to submit a task
/** Hold ≥2% of a coin's supply to be a recognized contributor (submit build prompts that steer the app). */
export const CONTRIBUTOR_MIN_HOLD_BPS = 200;
/** Hold ≥3% of $PYRE to submit a platform-improvement proposal (the meta-governance gate). */
export const PLATFORM_PROPOSAL_MIN_HOLD_BPS = 300;
/** A proposal is "backed" once its capped $PYRE vote weight reaches this share of supply. */
export const PLATFORM_PROPOSAL_QUORUM_BPS = 1000; // 10% of supply
/** OPEN, sub-quorum proposals older than this are auto-declined to keep the board current. */
export const PLATFORM_PROPOSAL_STALE_DAYS = 21;
/** Per-user daily withdrawal cap (USD): blast-radius limit if a session is compromised. */
export const WITHDRAW_DAILY_CAP_USD = 25_000;
/** Largest single in-app charge (checkout product or x402 call) in USD; manifests above it are rejected. */
export const MAX_CHARGE_USD = 250;
/** Per-user, per-app daily in-app spend cap (USD): an app can never drain a wallet in one sitting. */
export const DAILY_CHARGE_CAP_USD = 1_000;

/** Buyback executor: minimum accumulated revenue before a swap is worth the fees. */
export const MIN_BUYBACK_USD = 5;

/* ─────────────────────────── PONS v2 launch facts ─────────────────────────── */

/** PONS v2 launch tokens are plain 18-decimal ERC-20s (ERC20Burnable). */
export const TOKEN_DECIMALS = 18;
/** USDG (Global Dollar) has 6 decimals. */
export const USDG_DECIMALS = 6;
/** PONS v2 fixed supply: 1B tokens, minted whole to the per-launch bonding curve. Base units. */
export const PONS_TOTAL_SUPPLY = 1_000_000_000n * 10n ** BigInt(TOKEN_DECIMALS);
/** The curve closes and liquidity moves to a Uniswap v4 pool once it has raised this much ETH. */
export const PONS_GRADUATION_THRESHOLD_WEI = 4_200_000_000_000_000_000n;
/** `factory.launchFee()` — must be sent as `value` with every launch (0.0005 ETH). */
export const PONS_LAUNCH_FEE_WEI = 500_000_000_000_000n;

/**
 * `LaunchedToken.phase` from the PONS v2 factory — the authoritative routing signal for trades,
 * sweeps and price reads. Persisted verbatim as `App.launchPhase`.
 */
export const LAUNCH_PHASE = {
  /** Trading on the bonding curve. */
  CURVE: 0,
  /** Curve closed, liquidity being moved (transient). */
  SWEPT: 1,
  /** Graduated: trading in the Uniswap v4 pool. */
  POOL: 2,
  /** Graduation failed and the raise was rescued to the creator. */
  RESCUED: 3,
} as const;

/** Rate limits by launcher reputation tier (launches per 24h). */
export const LAUNCH_RATE_LIMIT_PER_DAY = { NEW: 5, TRUSTED: 15, VETERAN: 30 } as const;

/** Reputation thresholds. */
export const REPUTATION_TIERS = { TRUSTED: 20, VETERAN: 100 } as const;

/** Monitoring. */
export const HEALTHCHECK_INTERVAL_MS = 60_000;
export const HEALTHCHECK_FAILS_BEFORE_SELF_HEAL = 3;

/** Build stages in order. */
export const BUILD_STAGES = ["SCAFFOLD", "MVP", "DEPLOY", "VERIFY", "ITERATE"] as const;

/** Model routing. Cheap model for routine, expensive for architecture/fixes. Override via env. */
export const MODELS = {
  ROUTINE: "claude-sonnet-5",
  ARCHITECT: "claude-opus-5",
  REVIEWER: "claude-sonnet-5",
  INTAKE: "claude-sonnet-5",
  CLASSIFIER: "claude-haiku-4-5",
  GROWTH: "claude-sonnet-5",
} as const;

export const bps = (amount: bigint | number, b: number): bigint => {
  const a = typeof amount === "bigint" ? amount : BigInt(Math.floor(amount));
  return (a * BigInt(b)) / 10_000n;
};
