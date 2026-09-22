import { big, dec, prisma, type App, type User } from "@pyre/db";
import { getErc20Balance } from "@pyre/chain";
import type { Address } from "viem";
import {
  CONTRIBUTOR_MIN_HOLD_BPS,
  PLATFORM_PROPOSAL_MIN_HOLD_BPS,
  PLATFORM_PROPOSAL_QUORUM_BPS,
  PONS_TOTAL_SUPPLY,
  VOTE_WALLET_CAP_BPS,
  bps,
  venueOf,
} from "@pyre/shared";
import { env } from "../env.js";
import { cached } from "./cache.js";

/** $PYRE (a PONS v2 launch on Robinhood Chain) mints exactly this many base units. */
export const SUPPLY_BASE_UNITS = PONS_TOTAL_SUPPLY;
/** Minimum $PYRE holding to submit a platform-improvement proposal (base units) — the ≥3% gate. */
export const PLATFORM_PROPOSAL_MIN_HOLD = (SUPPLY_BASE_UNITS * BigInt(PLATFORM_PROPOSAL_MIN_HOLD_BPS)) / 10_000n;
/** Capped $PYRE weight at which a proposal is considered "backed" (base units) — the ≥10% quorum. */
export const PLATFORM_PROPOSAL_QUORUM = (SUPPLY_BASE_UNITS * BigInt(PLATFORM_PROPOSAL_QUORUM_BPS)) / 10_000n;
/** Max $PYRE governance weight a single wallet can carry (base units). */
const PLATFORM_VOTE_CAP = (SUPPLY_BASE_UNITS * BigInt(VOTE_WALLET_CAP_BPS)) / 10_000n;

/** What app-coin governance needs from an app row: its venue fixes the supply the bps gates apply to. */
export type GovApp = Pick<App, "id" | "chain" | "launchpad">;

/** Max governance weight a single wallet can carry on an app's coin (base units of that coin). */
export const voteCap = (app: GovApp): bigint => bps(venueOf(app).totalSupplyUnits, VOTE_WALLET_CAP_BPS);
/** Minimum holding to contribute build prompts that steer an app (base units) — the ≥2% contributor gate. */
export const contributorMinHold = (app: GovApp): bigint => bps(venueOf(app).totalSupplyUnits, CONTRIBUTOR_MIN_HOLD_BPS);

/** The viewer's custodial wallet on the app's chain, the one the holder snapshot is keyed by. */
export const holderWallet = (app: GovApp, user: Pick<User, "wallet" | "solWallet">): string | null => (app.chain === "solana" ? user.solWallet : user.wallet);

/** Live $PYRE balance (base units) of a wallet; 0 before $PYRE launches. Cached briefly (as a decimal string: the Redis tier is JSON): governance reads are bursty. */
export const pyreBalance = async (wallet: Address | null): Promise<bigint> => {
  if (!wallet || !env.PYRE_TOKEN) return 0n;
  const token = env.PYRE_TOKEN;
  return BigInt(await cached(`pyrebal:${wallet}`, 15_000, async () => (await getErc20Balance(token, wallet)).toString()));
};

/**
 * Live, capped $PYRE weight (base units) for a wallet, used for platform governance. Reads the
 * custodial wallet's $PYRE balance on demand (no snapshot needed) and caps it like every vote.
 */
export const platformHoldWeight = async (wallet: Address | null): Promise<bigint> => {
  const balance = await pyreBalance(wallet);
  return balance > PLATFORM_VOTE_CAP ? PLATFORM_VOTE_CAP : balance;
};

export const holderBalance = async (appId: string, wallet: string | null): Promise<bigint> => {
  if (!wallet) return 0n;
  const row = await prisma.holderBalance.findUnique({ where: { appId_wallet: { appId, wallet } } });
  return big(row?.amount);
};

/** Capped token-weighted vote weight for a wallet on an app. */
export const voteWeight = async (app: GovApp, wallet: string | null): Promise<bigint> => {
  const balance = await holderBalance(app.id, wallet);
  const cap = voteCap(app);
  return balance > cap ? cap : balance;
};

/** Sum of capped weights across all holders — the electorate size for majority checks. */
export const cappedElectorate = async (app: GovApp): Promise<bigint> => {
  const capUnits = voteCap(app);
  const cap = dec(capUnits);
  const [capped, uncapped] = await Promise.all([
    prisma.holderBalance.count({ where: { appId: app.id, amount: { gt: cap } } }),
    prisma.holderBalance.aggregate({ where: { appId: app.id, amount: { lte: cap } }, _sum: { amount: true } }),
  ]);
  return BigInt(capped) * capUnits + big(uncapped._sum.amount);
};

/**
 * Maintainer election threshold: a strict majority of the capped electorate. Exactly half the
 * electorate is not a majority, and an empty electorate can never elect anyone. Doubling the
 * support instead of halving the electorate keeps the comparison exact for odd electorates.
 */
export const isElected = (support: bigint, electorate: bigint): boolean => electorate > 0n && support * 2n > electorate;
