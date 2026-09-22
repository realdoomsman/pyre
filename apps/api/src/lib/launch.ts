import { adapterFor, type VenueAccount, type VenueAdapter } from "@pyre/chain";
import { Prisma, prisma, type App, type User } from "@pyre/db";
import { AppSpec, LAUNCH_RATE_LIMIT_PER_DAY, RESERVED_SLUGS, SPEC_INTAKE_BUDGET_USD, VENUES, slugify, type CreateLaunchBody, type StakeBody } from "@pyre/shared";
import { reputationTier } from "./auth.js";
import { GAS_RESERVE_BY_CHAIN } from "./custodial.js";
import { HttpError } from "./errors.js";
import { publishEvent } from "./events.js";
import { logger } from "./logger.js";
import { queues } from "./queues.js";
import { assertVenueEnabled, requiredStake, type VenueRow } from "./venue.js";

/**
 * Launches that count against the daily cap: everything the user created in the last 24h except
 * intakes the classifier refused — those cost nothing and a refused idea reworded is the expected
 * next step, not abuse.
 */
export const launchesLast24h = (userId: string): Promise<number> =>
  prisma.app.count({ where: { launcherId: userId, createdAt: { gte: new Date(Date.now() - 86_400_000) }, status: { not: "FAILED" } } });

/**
 * Creates a DRAFT app for the launcher on the chosen venue, assigns a unique slug + derived app
 * wallet on that chain (the PONS creator / creatorFeeRecipient, or the pump.fun creator), and
 * enqueues the intake job (moderation + spec generation). A fork launches on its parent's venue.
 */
export const createLaunch = async (user: User, body: CreateLaunchBody, forkOf: App | null): Promise<App> => {
  if (!user.wallet) throw new HttpError(400, "wallet_required");
  const launchpad = forkOf ? forkOf.launchpad : body.launchpad;
  assertVenueEnabled(launchpad);
  const venue = VENUES[launchpad];
  const tier = reputationTier(user.reputation);
  const limit = LAUNCH_RATE_LIMIT_PER_DAY[tier];
  if (!user.isAdmin && (await launchesLast24h(user.id)) >= limit) {
    throw new HttpError(429, "launch_rate_limited", { limitPerDay: limit, tier });
  }
  let prompt = body.prompt;
  if (forkOf) {
    const parentSpec = AppSpec.safeParse(forkOf.spec);
    const parentSummary = parentSpec.success
      ? `Original spec:\nTitle: ${parentSpec.data.title}\nOne-liner: ${parentSpec.data.oneLiner}\nWhat it does: ${parentSpec.data.whatItDoes}\nMVP:\n${parentSpec.data.mvp.map((m) => `- ${m}`).join("\n")}`
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
          chain: venue.chain,
          launchpad: venue.launchpad,
        },
      });
      const walletAddress = adapterFor(launchpad).appWallet(created.keypairIndex).address;
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
  txHash: string;
  /** The refundable stake credited to the launch: exactly the chain's stake, never the transfer's full value. */
  wei: bigint;
  from: string;
  /** True when the platform signed the transfer from the user's custodial wallet. */
  custodial: boolean;
}

/** The adapter surface `settleStake` needs; injected so the decision logic is testable offline. */
export type StakeChain = Pick<VenueAdapter, "verifyNativeTransfer" | "transferNative" | "nativeBalance" | "treasury" | "userWallet">;

/**
 * True when `address` is a wallet the platform itself signs for: the treasury, any user's custodial
 * wallet, or any app wallet. Transfers from those are platform money movements (fee sweeps, drains,
 * escrows), never a launcher's stake — even if a launcher somehow proved such an address.
 */
const isPlatformWallet = async (address: string, treasury: string): Promise<boolean> => {
  if (address.toLowerCase() === treasury.toLowerCase()) return true;
  const [user, app] = await Promise.all([
    prisma.user.findFirst({ where: { OR: [{ wallet: { equals: address, mode: "insensitive" } }, { solWallet: address }] }, select: { id: true } }),
    prisma.app.findFirst({ where: { walletAddress: { equals: address, mode: "insensitive" } }, select: { id: true } }),
  ]);
  return user !== null || app !== null;
};

/**
 * Settles the refundable launch stake (`LAUNCH_STAKE_BY_CHAIN`, in the app chain's native asset)
 * into the treasury wallet on that chain:
 *  - `{txHash}`: an external-wallet transfer the launcher already sent. Only launchers with a
 *    proven `authWallet` may use it, and the tx must be mined, successful, `to` = treasury,
 *    value ≥ stake and `from` = that `authWallet` — otherwise any inbound treasury tx (fee sweeps,
 *    escrows) could be claimed as a stake and refunded. The sender must not be a platform wallet.
 *    A hash can only ever settle one launch (`App.stakeTx` is unique; checked here for an early
 *    409 and enforced by the database on write). A wallet is only ever proven on Robinhood Chain,
 *    so Solana stakes are custodial.
 *  - `{custodial:true}`: the platform signs the transfer out of the launcher's custodial wallet on
 *    the app's chain.
 * The credited stake is always exactly the chain's stake: an overpaid external transfer is not
 * refunded beyond it.
 */
export const settleStake = async (
  app: Pick<App, "id"> & VenueRow,
  user: Pick<User, "id" | "wallet" | "authWallet" | "walletIndex">,
  body: StakeBody,
  chain: StakeChain = adapterFor(app.launchpad),
): Promise<StakeSettlement> => {
  const wei = requiredStake(app.chain);
  const treasury = chain.treasury().address;
  if ("txHash" in body) {
    if (!user.authWallet || app.chain !== "robinhood") {
      throw new HttpError(400, "external_wallet_required", {
        hint: app.chain === "robinhood" ? "sign in with the wallet that sent the stake, or use {custodial:true}" : "stakes on this chain are paid from your Pyre wallet: use {custodial:true}",
      });
    }
    const from = user.authWallet;
    const reused = await prisma.app.findFirst({ where: { stakeTx: body.txHash, NOT: { id: app.id } }, select: { id: true } });
    if (reused) throw new HttpError(409, "stake_tx_already_used");
    const check = await chain.verifyNativeTransfer(body.txHash, treasury, wei, from);
    if (!check.ok) throw new HttpError(400, "stake_tx_invalid", { reason: check.reason ?? "unverified", to: treasury, minWei: wei.toString() });
    if (await isPlatformWallet(check.from, treasury)) {
      throw new HttpError(400, "stake_tx_invalid", { reason: "platform-sender", to: treasury, minWei: wei.toString() });
    }
    return { txHash: body.txHash, wei, from: check.from, custodial: false };
  }
  if (!user.wallet) throw new HttpError(400, "wallet_required");
  const account: VenueAccount = chain.userWallet(user.walletIndex);
  const balance = await chain.nativeBalance(account.address);
  const need = wei + GAS_RESERVE_BY_CHAIN[app.chain];
  if (balance < need) throw new HttpError(400, "insufficient_balance", { haveWei: balance.toString(), needWei: need.toString(), to: treasury });
  let txHash: string;
  try {
    txHash = (await chain.transferNative(account, treasury, wei)).hash;
  } catch (err) {
    logger.error({ err, appId: app.id, userId: user.id }, "launch stake transfer failed");
    throw new HttpError(502, "stake_failed");
  }
  return { txHash, wei, from: account.address, custodial: true };
};
