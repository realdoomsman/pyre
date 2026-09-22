import { getAddress, isAddress } from "viem/utils";
import { z } from "zod";
import { LAUNCH_PHASE } from "./constants.js";
import { Launchpad } from "./venues.js";

/* ─────────────────────────── Chain primitives ─────────────────────────── */

/**
 * EVM address: accepts lowercase or correctly EIP-55-checksummed input, rejects a wrong mixed-case
 * checksum (a typo, not a different casing), and always outputs the checksummed form so every
 * address stored or compared by the platform has exactly one spelling.
 */
export const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte hex address")
  .refine((a) => {
    const hex = a.slice(2);
    return hex === hex.toLowerCase() || hex === hex.toUpperCase() || isAddress(a, { strict: true });
  }, "bad address checksum")
  .transform((a) => getAddress(a));

/** 32-byte transaction hash, canonicalised to lowercase. */
export const TxHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte hex hash")
  .transform((h) => h.toLowerCase() as `0x${string}`);
export type TxHash = z.output<typeof TxHash>;

/** PONS v2 `LaunchedToken.phase` (see `LAUNCH_PHASE`). */
export const LaunchPhase = z.union([
  z.literal(LAUNCH_PHASE.CURVE),
  z.literal(LAUNCH_PHASE.SWEPT),
  z.literal(LAUNCH_PHASE.POOL),
  z.literal(LAUNCH_PHASE.RESCUED),
]);
export type LaunchPhase = z.infer<typeof LaunchPhase>;

/* ─────────────────────────── Spec (intake output) ─────────────────────────── */

export const AppSpec = z.object({
  title: z.string().min(2).max(80),
  oneLiner: z.string().min(10).max(160),
  whatItDoes: z.string().min(20).max(1200),
  mvp: z.array(z.string().min(3).max(200)).min(1).max(8),
  outOfScope: z.array(z.string().max(200)).max(8).default([]),
  holderTier: z.object({
    enabled: z.boolean(),
    minHoldTokens: z.number().int().min(0).nullable(),
    perks: z.array(z.string().max(160)).max(6).default([]),
  }),
  template: z.enum(["WEB_TOOL", "GAME", "AGENT_API"]).default("WEB_TOOL"),
  risks: z.array(z.string().max(200)).max(5).default([]),
});
export type AppSpec = z.infer<typeof AppSpec>;

/* ─────────────────────────── Moderation ─────────────────────────── */

export const ModerationVerdict = z.object({
  allowed: z.boolean(),
  category: z.enum([
    "OK",
    "SCAM",
    "PHISHING",
    "GAMBLING",
    "ILLEGAL",
    "IMPERSONATION",
    "ADULT",
    "HATE",
    "OTHER",
  ]),
  reason: z.string().max(400),
});
export type ModerationVerdict = z.infer<typeof ModerationVerdict>;

/* ─────────────────────────── Build feed events ─────────────────────────── */

export const BuildEventType = z.enum([
  "JOB_QUEUED",
  "JOB_STARTED",
  "STAGE",
  "AGENT_NOTE",
  "TOOL_CALL",
  "COMMIT",
  "TEST_RESULT",
  "SCREENSHOT",
  "LIGHTHOUSE",
  "REVIEW",
  "DEPLOY",
  "JOB_FINISHED",
  "JOB_FAILED",
  "BUDGET",
  "MILESTONE",
  "REVIVED",
  "DORMANT",
  "SELF_HEAL",
  "PR_MERGED",
  "BOUNTY_CLAIMED",
  "GROWTH_POST",
  "LAUNCH",
  "LAUNCH_GATED",
  "FEES",
  "TRADE",
  "GRADUATED",
]);
export type BuildEventType = z.infer<typeof BuildEventType>;

export const BuildEventPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("JOB_QUEUED"), stage: z.string(), budgetUsd: z.number() }),
  z.object({ type: z.literal("JOB_STARTED"), stage: z.string(), model: z.string(), sandboxId: z.string() }),
  z.object({ type: z.literal("STAGE"), stage: z.string(), status: z.enum(["START", "DONE", "FAIL"]) }),
  z.object({ type: z.literal("AGENT_NOTE"), text: z.string() }),
  z.object({ type: z.literal("TOOL_CALL"), tool: z.string(), summary: z.string() }),
  z.object({ type: z.literal("COMMIT"), sha: z.string(), message: z.string(), url: z.string().nullable() }),
  z.object({
    type: z.literal("TEST_RESULT"),
    passed: z.number(),
    failed: z.number(),
    output: z.string(),
  }),
  z.object({ type: z.literal("SCREENSHOT"), url: z.string(), label: z.string() }),
  z.object({
    type: z.literal("LIGHTHOUSE"),
    performance: z.number(),
    accessibility: z.number(),
    bestPractices: z.number(),
    seo: z.number(),
  }),
  z.object({
    type: z.literal("REVIEW"),
    verdict: z.enum(["APPROVE", "REJECT"]),
    summary: z.string(),
    findings: z.array(z.object({ severity: z.enum(["INFO", "WARN", "BLOCK"]), text: z.string() })),
  }),
  z.object({ type: z.literal("DEPLOY"), version: z.number(), url: z.string() }),
  z.object({ type: z.literal("JOB_FINISHED"), costUsd: z.number(), durationMs: z.number(), summary: z.string() }),
  z.object({ type: z.literal("JOB_FAILED"), costUsd: z.number(), error: z.string() }),
  z.object({ type: z.literal("BUDGET"), budgetUsd: z.number(), delta: z.number(), reason: z.string() }),
  z.object({ type: z.literal("MILESTONE"), milestone: z.string(), value: z.number() }),
  z.object({ type: z.literal("REVIVED"), by: z.string(), budgetUsd: z.number() }),
  z.object({ type: z.literal("DORMANT"), reason: z.string() }),
  z.object({ type: z.literal("SELF_HEAL"), error: z.string() }),
  z.object({ type: z.literal("PR_MERGED"), prNumber: z.number(), author: z.string(), url: z.string() }),
  z.object({ type: z.literal("BOUNTY_CLAIMED"), bountyId: z.string(), amountWei: z.string(), claimant: EvmAddress }),
  z.object({ type: z.literal("GROWTH_POST"), url: z.string(), text: z.string() }),
  // chain events (runner → feed); addresses and hashes are venue-formatted strings (0x… / base58)
  z.object({
    type: z.literal("LAUNCH"),
    tokenAddress: z.string(),
    curveAddress: z.string(),
    launchpadUrl: z.string(),
    explorerUrl: z.string(),
    txHash: z.string(),
  }),
  z.object({ type: z.literal("LAUNCH_GATED"), wallet: z.string() }),
  z.object({
    type: z.literal("FEES"),
    /** Native base units of the app's chain. */
    wei: z.string(),
    usdMicros: z.string(),
    buildMicros: z.string(),
    txHash: z.string(),
    explorerUrl: z.string(),
  }),
  z.object({
    type: z.literal("TRADE"),
    side: z.enum(["BUY", "SELL"]),
    wallet: z.string(),
    tokenUnits: z.string(),
    quoteWei: z.string(),
    priceUsd: z.number(),
    txHash: z.string(),
  }),
  z.object({ type: z.literal("GRADUATED"), poolId: z.string(), txHash: z.string().nullable() }),
]);
export type BuildEventPayload = z.infer<typeof BuildEventPayload>;

/* ─────────────────────────── Runner ⇄ API contract ─────────────────────────── */

/** Job payload placed on the `build` queue by the API. */
export const BuildJobData = z.object({
  jobId: z.string(),
  appId: z.string(),
  stage: z.enum(["SCAFFOLD", "MVP", "DEPLOY", "VERIFY", "ITERATE", "SELF_HEAL", "PR_REVIEW"]),
  budgetUsd: z.number().positive(),
  /** Prompt-queue task ids consumed by this iteration. */
  taskIds: z.array(z.string()).default([]),
  /** Optional free-text instruction (self-heal error, PR diff summary). */
  instruction: z.string().optional(),
  /** PR number for PR_REVIEW. */
  prNumber: z.number().optional(),
});
export type BuildJobData = z.infer<typeof BuildJobData>;

/** Lines streamed by the in-sandbox runner script (JSONL on stdout). */
export const SandboxRunnerLine = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), text: z.string() }),
  z.object({ kind: z.literal("tool"), name: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("cost"), totalUsd: z.number() }),
  z.object({ kind: z.literal("result"), ok: z.boolean(), totalUsd: z.number(), summary: z.string(), turns: z.number() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type SandboxRunnerLine = z.infer<typeof SandboxRunnerLine>;

/* ─────────────────────────── App deployment manifest ─────────────────────────── */

/** Every app the agent builds must produce this at pyre.manifest.json. */
export const PyreManifest = z.object({
  name: z.string(),
  version: z.string().default("0.0.0"),
  /** Static entry served at the app root. */
  entry: z.string().default("index.html"),
  /** Server functions exported from functions/*.js, executed in the platform sandbox runtime. */
  functions: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9_-]{1,40}$/),
        /** Require an authenticated user. */
        auth: z.boolean().default(false),
        /** Require the holder tier. */
        holderOnly: z.boolean().default(false),
      }),
    )
    .default([]),
  holderTier: z.object({ minHoldTokens: z.number().int().min(0) }).nullable().default(null),
});
export type PyreManifest = z.infer<typeof PyreManifest>;

/* ─────────────────────────── Public API DTOs ─────────────────────────── */

/** Absolute http(s) URL only: `javascript:`/`data:` never reach an `<a href>` or the on-chain metadata. */
export const httpUrl = (maxLength: number) =>
  z
    .string()
    .max(maxLength)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "expected an http(s) URL");

export const CreateLaunchBody = z.object({
  name: z.string().min(2).max(32),
  ticker: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z0-9]+$/),
  imageUrl: httpUrl(500),
  prompt: z.string().min(20).max(4000),
  twitter: httpUrl(200).optional(),
  website: httpUrl(200).optional(),
  forkOfAppId: z.string().optional(),
  /** Where the coin is created; the chain follows from it (`VENUES`). Forks launch on the parent's venue. */
  launchpad: Launchpad.default("pons_v2"),
});
export type CreateLaunchBody = z.infer<typeof CreateLaunchBody>;

export const ApproveSpecBody = z.object({
  spec: AppSpec,
});

/** Custodial launch stake takes no amount (fixed `LAUNCH_STAKE_BY_CHAIN`); a top-up specifies whole native units of the app's chain (ETH or SOL). */
export const TopupBody = z.object({
  amount: z.number().positive().max(1000),
});

/** Stake $PYRE: token count (whole tokens, converted to base units server-side). */
export const PyreStakeBody = z.object({
  appId: z.string().min(1),
  amount: z.number().positive(),
});

/** Base58 Solana public key (32 bytes encode to 32–44 characters). The adapter re-checks the decoded length. */
export const SolanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a base58 Solana address");
export type SolanaAddress = z.infer<typeof SolanaAddress>;

/** Base58 Solana transaction signature (64 bytes encode to 87–88 characters). */
export const SolanaSignature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{86,90}$/, "expected a base58 Solana signature");

const withdrawAmount = z.number().positive().finite().max(1_000_000);

/**
 * Withdraw from a custodial wallet to any external address. ETH/USDG leave the Robinhood Chain
 * wallet, SOL the Solana wallet; the destination is validated by the asset's chain.
 */
export const WithdrawBody = z.discriminatedUnion("asset", [
  z.object({ asset: z.enum(["ETH", "USDG"]), to: EvmAddress, amount: withdrawAmount }),
  z.object({ asset: z.literal("SOL"), to: SolanaAddress, amount: withdrawAmount }),
]);
export type WithdrawBody = z.infer<typeof WithdrawBody>;

export const PromptQueueBody = z.object({
  text: z.string().min(10).max(1000),
});

export const BountyBody = z.object({
  title: z.string().min(5).max(120),
  description: z.string().min(10).max(2000),
  eth: z.number().positive().max(1000),
});

export const LeaderboardSort = z.enum(["users", "newest", "dormant", "building"]);
export type LeaderboardSort = z.infer<typeof LeaderboardSort>;

/**
 * On-chain slice of an app DTO (API → web). ETH figures are display numbers; the exact wei live in
 * the DB. `phase` follows `LAUNCH_PHASE`; `progress` is the curve's raise as a fraction of
 * `graduationThresholdEth`, pinned to 1 once graduated.
 */
export const AppChainDto = z.object({
  tokenAddress: EvmAddress.nullable(),
  walletAddress: EvmAddress.nullable(),
  curveAddress: EvmAddress.nullable(),
  poolId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
  phase: LaunchPhase,
  stakeEth: z.number().min(0),
  feesEth: z.number().min(0),
  progress: z.number().min(0).max(1),
  graduationThresholdEth: z.number().positive(),
  ponsUrl: z.string().url().nullable(),
  explorerUrl: z.string().url().nullable(),
});
export type AppChainDto = z.infer<typeof AppChainDto>;
