import { big, dec, prisma } from "@pyre/db";
import { getErc20Balance } from "@pyre/chain";
import type { Address } from "viem";
import {
  CONTRIBUTOR_MIN_HOLD_BPS,
  PLATFORM_PROPOSAL_MIN_HOLD_BPS,
  PLATFORM_PROPOSAL_QUORUM_BPS,
  PONS_TOTAL_SUPPLY,
  PROMPT_QUEUE_MIN_HOLD_BPS,
  VOTE_WALLET_CAP_BPS,
} from "@pyre/shared";
import { env } from "../env.js";
import { cached } from "./cache.js";

/** Every PONS v2 launch (app coins and $PYRE alike) mints exactly this many base units. */
export const SUPPLY_BASE_UNITS = PONS_TOTAL_SUPPLY;
/** Max governance weight a single wallet can carry (base units). */
export const VOTE_CAP = (SUPPLY_BASE_UNITS * BigInt(VOTE_WALLET_CAP_BPS)) / 10_000n;
/** Minimum holding to submit a prompt-queue task (base units). */
export const QUEUE_MIN_HOLD = (SUPPLY_BASE_UNITS * BigInt(PROMPT_QUEUE_MIN_HOLD_BPS)) / 10_000n;
/** Minimum holding to contribute build prompts that steer an app (base units) — the ≥2% contributor gate. */
export const CONTRIBUTOR_MIN_HOLD = (SUPPLY_BASE_UNITS * BigInt(CONTRIBUTOR_MIN_HOLD_BPS)) / 10_000n;
/** Minimum $PYRE holding to submit a platform-improvement proposal (base units) — the ≥3% gate. */
export const PLATFORM_PROPOSAL_MIN_HOLD = (SUPPLY_BASE_UNITS * BigInt(PLATFORM_PROPOSAL_MIN_HOLD_BPS)) / 10_000n;
/** Capped $PYRE weight at which a proposal is considered "backed" (base units) — the ≥10% quorum. */
export const PLATFORM_PROPOSAL_QUORUM = (SUPPLY_BASE_UNITS * BigInt(PLATFORM_PROPOSAL_QUORUM_BPS)) / 10_000n;

/** Live $PYRE balance (base units) of a wallet; 0 before $PYRE launches. Cached briefly: governance reads are bursty. */
export const pyreBalance = async (wallet: Address | null): Promise<bigint> => {
  if (!wallet || !env.PYRE_TOKEN) return 0n;
  const token = env.PYRE_TOKEN;
  return cached(`pyrebal:${wallet}`, 15_000, () => getErc20Balance(token, wallet));
};

/**
 * Live, capped $PYRE weight (base units) for a wallet, used for platform governance. Reads the
 * custodial wallet's $PYRE balance on demand (no snapshot needed) and caps it like every vote.
 */
export const platformHoldWeight = async (wallet: Address | null): Promise<bigint> => {
  const balance = await pyreBalance(wallet);
  return balance > VOTE_CAP ? VOTE_CAP : balance;
};

export const holderBalance = async (appId: string, wallet: string | null): Promise<bigint> => {
  if (!wallet) return 0n;
  const row = await prisma.holderBalance.findUnique({ where: { appId_wallet: { appId, wallet } } });
  return big(row?.amount);
};

/** Capped token-weighted vote weight for a wallet on an app. */
export const voteWeight = async (appId: string, wallet: string | null): Promise<bigint> => {
  const balance = await holderBalance(appId, wallet);
  return balance > VOTE_CAP ? VOTE_CAP : balance;
};

/** Sum of capped weights across all holders — the electorate size for majority checks. */
export const cappedElectorate = async (appId: string): Promise<bigint> => {
  const cap = dec(VOTE_CAP);
  const [capped, uncapped] = await Promise.all([
    prisma.holderBalance.count({ where: { appId, amount: { gt: cap } } }),
    prisma.holderBalance.aggregate({ where: { appId, amount: { lte: cap } }, _sum: { amount: true } }),
  ]);
  return BigInt(capped) * VOTE_CAP + big(uncapped._sum.amount);
};

/**
 * Maintainer election threshold: a strict majority of the capped electorate. Exactly half the
 * electorate is not a majority, and an empty electorate can never elect anyone. Doubling the
 * support instead of halving the electorate keeps the comparison exact for odd electorates.
 */
export const isElected = (support: bigint, electorate: bigint): boolean => electorate > 0n && support * 2n > electorate;
