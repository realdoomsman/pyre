import { deriveAppWallet, transferEth, verifyEthTransfer, type EthTransferCheck } from "@pyre/chain";
import { Prisma, prisma, type App, type User } from "@pyre/db";
import { AppSpec, LAUNCH_RATE_LIMIT_PER_DAY, RESERVED_SLUGS, SPEC_INTAKE_BUDGET_USD, slugify, type CreateLaunchBody, type StakeBody } from "@pyre/shared";
import type { Address, Hash, LocalAccount } from "viem";
import { env } from "../env.js";
import { reputationTier } from "./auth.js";
import { custodialAccount, custodialEthBalance, GAS_RESERVE_WEI } from "./custodial.js";
import { HttpError } from "./errors.js";
import { publishEvent } from "./events.js";
import { logger } from "./logger.js";
import { queues } from "./queues.js";
import { TREASURY_WALLET } from "./treasury.js";

/**
 * Launches that count against the daily cap: everything the user created in the last 24h except
 * intakes the classifier refused — those cost nothing and a refused idea reworded is the expected
 * next step, not abuse.
 */
export const launchesLast24h = (userId: string): Promise<number> =>
  prisma.app.count({ where: { launcherId: userId, createdAt: { gte: new Date(Date.now() - 86_400_000) }, status: { not: "FAILED" } } });

/**
 * Creates a DRAFT app for the launcher, assigns a unique slug + derived app wallet (the PONS
 * creator / creatorFeeRecipient), and enqueues the intake job (moderation + spec generation).
 */
export const createLaunch = async (user: User, body: CreateLaunchBody, forkOf: App | null): Promise<App> => {
  if (!user.wallet) throw new HttpError(400, "wallet_required");
  const tier = reputationTier(user.reputation);
  const limit = LAUNCH_RATE_LIMIT_PER_DAY[tier];
  if (!user.isAdmin && (await launchesLast24h(user.id)) >= limit) {
    throw new HttpError(429, "launch_rate_limited", { limitPerDay: limit, tier });
  }

  let prompt = body.prompt;
  if (forkOf) {
    const parentSpec = AppSpec.safeParse(forkOf.spec);
    const parentSummary = parentSpec.success
      ? `Original spec:\nTitle: ${parentSpec.data.title}\nOne-liner: ${parentSpec.data.oneLiner}\nWhat it does: ${parentSpec.data.whatItDoes}\nWho pays: ${parentSpec.data.whoPays}\nMVP:\n${parentSpec.data.mvp.map((m) => `- ${m}`).join("\n")}\nMonetization: ${parentSpec.data.monetization.model} (${parentSpec.data.monetization.priceDescription})`
      : `Original prompt:\n${forkOf.prompt}`;
    prompt = `Fork of "${forkOf.name}" ($${forkOf.ticker}, ${forkOf.repoUrl ?? "no public repo yet"}).\n${parentSummary}\n\nChanges requested by the forker:\n${body.prompt}`;
  }

  const base = slugify(body.name);
  const taken = await prisma.app.findMany({
    where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
    select: { slug: true },
  });
  const used: Record<string, true> = {};
  for (const t of taken) used[t.slug] = true;
  let slug = RESERVED_SLUGS[base] || used[base] ? "" : base;
  for (let n = 2; slug === ""; n++) {
    const candidate = `${base}-${n}`;
    if (!used[candidate] && !RESERVED_SLUGS[candidate]) slug = candidate;
  }

  let app: App;
  try {
    app = await prisma.$transaction(async (tx) => {
      const created = await tx.app.create({
        data: {
          slug,
          name: body.name,
          ticker: body.ticker,
          imageUrl: body.imageUrl,
          prompt,
          launcherId: user.id,
          twitterUrl: body.twitter ?? null,
          websiteUrl: body.website ?? null,
          forkOfId: forkOf?.id ?? null,
        },
      });
      const walletAddress = deriveAppWallet(created.keypairIndex).address;
      return tx.app.update({ where: { id: created.id }, data: { walletAddress } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new HttpError(409, "slug_taken", { slug });
    }
    throw err;
  }

  await queues.intake.add(
    "intake",
    { appId: app.id },
    {
      jobId: `intake-${app.id}`,
      // Ride out a transient provider blip; the worker settles the app as FAILED
      // once these are exhausted so the launcher never polls forever.
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
    },
  );
  await publishEvent(app.id, { type: "JOB_QUEUED", stage: "INTAKE", budgetUsd: SPEC_INTAKE_BUDGET_USD });
  return app;
};

/* ─────────────────────────── Stake ─────────────────────────── */

export interface StakeSettlement {
  txHash: Hash;
  /** The refundable stake credited to the launch: exactly `LAUNCH_STAKE_WEI`, never the transfer's full value. */
  wei: bigint;
  from: Address;
  /** True when the platform signed the transfer from the user's custodial wallet. */
  custodial: boolean;
}

/** Minimal chain surface `settleStake` needs; injected so the decision logic is testable offline. */
export interface StakeChain {
  verifyEthTransfer: (hash: Hash, opts: { to: Address; minWei: bigint; from: Address }) => Promise<EthTransferCheck>;
  transferEth: (from: LocalAccount, to: Address, wei: bigint) => Promise<Hash>;
  ethBalance: (wallet: Address) => Promise<bigint>;
}

const liveChain: StakeChain = { verifyEthTransfer, transferEth, ethBalance: custodialEthBalance };

/**
 * True when `address` is a wallet the platform itself signs for: the treasury, any user's custodial
 * wallet, or any app wallet. Transfers from those are platform money movements (fee sweeps, drains,
 * escrows), never a launcher's stake — even if a launcher somehow proved such an address.
 */
const isPlatformWallet = async (address: Address): Promise<boolean> => {
  if (address.toLowerCase() === TREASURY_WALLET.toLowerCase()) return true;
  const [user, app] = await Promise.all([
    prisma.user.findFirst({ where: { wallet: { equals: address, mode: "insensitive" } }, select: { id: true } }),
    prisma.app.findFirst({ where: { walletAddress: { equals: address, mode: "insensitive" } }, select: { id: true } }),
  ]);
  return user !== null || app !== null;
};

/**
 * Settles the refundable launch stake (`LAUNCH_STAKE_WEI`, ETH) into the treasury:
 *  - `{txHash}`: an external-wallet transfer the launcher already sent. Only launchers with a
 *    proven `authWallet` may use it, and the tx must be mined, successful, `to` = treasury,
 *    value ≥ stake and `from` = that `authWallet` — otherwise any inbound treasury tx (fee sweeps,
 *    escrows) could be claimed as a stake and refunded. The sender must not be a platform wallet.
 *    A hash can only ever settle one launch (`App.stakeTx` is unique; checked here for an early
 *    409 and enforced by the database on write).
 *  - `{custodial:true}`: the platform signs the transfer out of the launcher's custodial wallet.
 * The credited stake is always exactly `LAUNCH_STAKE_WEI`: an overpaid external transfer is not
 * refunded beyond the stake.
 */
export const settleStake = async (
  app: Pick<App, "id">,
  user: Pick<User, "id" | "wallet" | "authWallet" | "walletIndex">,
  body: StakeBody,
  chain: StakeChain = liveChain,
): Promise<StakeSettlement> => {
  const wei = env.LAUNCH_STAKE_WEI;
  if ("txHash" in body) {
    if (!user.authWallet) throw new HttpError(400, "external_wallet_required", { hint: "sign in with the wallet that sent the stake, or use {custodial:true}" });
    const from = user.authWallet as Address;
    const reused = await prisma.app.findFirst({ where: { stakeTx: body.txHash, NOT: { id: app.id } }, select: { id: true } });
    if (reused) throw new HttpError(409, "stake_tx_already_used");
    const check = await chain.verifyEthTransfer(body.txHash, { to: TREASURY_WALLET, minWei: wei, from });
    if (!check.ok) throw new HttpError(400, "stake_tx_invalid", { reason: check.reason ?? "unverified", to: TREASURY_WALLET, minWei: wei.toString() });
    if (await isPlatformWallet(check.from)) {
      throw new HttpError(400, "stake_tx_invalid", { reason: "platform-sender", to: TREASURY_WALLET, minWei: wei.toString() });
    }
    return { txHash: body.txHash, wei, from: check.from, custodial: false };
  }
  if (!user.wallet) throw new HttpError(400, "wallet_required");
  const wallet = user.wallet as Address;
  const balance = await chain.ethBalance(wallet);
  const need = wei + GAS_RESERVE_WEI;
  if (balance < need) throw new HttpError(400, "insufficient_balance", { haveWei: balance.toString(), needWei: need.toString(), to: TREASURY_WALLET });
  let txHash: Hash;
  try {
    txHash = await chain.transferEth(custodialAccount(user), TREASURY_WALLET, wei);
  } catch (err) {
    logger.error({ err, appId: app.id, userId: user.id }, "launch stake transfer failed");
    throw new HttpError(502, "stake_failed");
  }
  return { txHash, wei, from: wallet, custodial: true };
};
