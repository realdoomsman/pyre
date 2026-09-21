import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { big, dec, prisma, type App } from "@pyre/db";
import { TransactionUnconfirmedError, getEthPriceUsd, transferErc20, transferEth, explorerTxUrl } from "@pyre/chain";
import { FEE_SPLIT_BPS, PyreStakeBody, REVENUE_SPLIT_BPS, TOKEN_DECIMALS, decimalToUnits, explorerTokenUrl, ponsUrl, weiFromUsdMicros, type PyrePageDto } from "@pyre/shared";
import { optionalAuth, requireAuth } from "../lib/auth.js";
import { writeAudit } from "../lib/audit.js";
import { APPS_TAG, cached } from "../lib/cache.js";
import { custodialAccount, custodialEthBalance, GAS_RESERVE_WEI } from "../lib/custodial.js";
import { pctOfSupply, stakeDto } from "../lib/dto.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { sendCached } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { db } from "../lib/metrics.js";
import { marketSnapshot } from "../lib/market.js";
import { TREASURY_ACCOUNT, TREASURY_WALLET } from "../lib/treasury.js";
import { PLATFORM_PROPOSAL_MIN_HOLD, pyreBalance } from "../lib/votes.js";
import { env } from "../env.js";

export const pyre = Router();

type AppRef = Pick<App, "id" | "slug" | "name" | "ticker">;
const APP_REF = { id: true, slug: true, name: true, ticker: true } as const;

/** Platform-wide $PYRE aggregates: identical for every viewer, so cached and shared. */
const loadOverview = async (): Promise<Omit<PyrePageDto, "viewer">> => {
  const [fees, revenue, balance, burned, staked, stakers, top, burns, proposalsOpen, proposalsShipped] = await db.$transaction([
    db.ledgerEntry.aggregate({ where: { account: "PYRE_TOKEN", refType: "FeeEvent" }, _sum: { deltaMicros: true } }),
    db.ledgerEntry.aggregate({ where: { account: "PYRE_TOKEN", refType: { in: ["RevenueEvent", "Buyback"] }, deltaMicros: { gt: 0n } }, _sum: { deltaMicros: true } }),
    // What is still to be bought: the running PYRE_TOKEN balance, net of every debit already claimed by a burn.
    db.ledgerEntry.aggregate({ where: { account: "PYRE_TOKEN" }, _sum: { deltaMicros: true } }),
    // Only settled burns count as burned: a failed or in-flight PyreBurn has debited the ledger but burned nothing yet.
    db.pyreBurn.aggregate({ where: { status: "BURNED" }, _sum: { usdMicros: true } }),
    db.pyreStake.aggregate({ where: { withdrawnAt: null }, _sum: { amount: true, earnedMicros: true } }),
    // COUNT(DISTINCT) in the database instead of materializing every staker wallet.
    db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(DISTINCT "wallet")::bigint AS count FROM "PyreStake" WHERE "withdrawnAt" IS NULL`,
    db.pyreStake.groupBy({ by: ["appId"], where: { withdrawnAt: null }, _sum: { amount: true }, _count: { _all: true }, orderBy: { _sum: { amount: "desc" } }, take: 10 }),
    db.pyreBurn.findMany({ where: { status: "BURNED" }, orderBy: { completedAt: "desc" }, take: 20 }),
    db.proposal.count({ where: { status: "OPEN" } }),
    db.proposal.count({ where: { status: "SHIPPED" } }),
  ]);
  const [market, topApps] = await Promise.all([
    marketSnapshot(),
    top.length > 0 ? db.app.findMany({ where: { id: { in: top.map((t) => t.appId) } }, select: APP_REF }) : Promise.resolve([]),
  ]);
  const snapshot = market?.pyreToken ?? null;
  const appById: Record<string, AppRef> = {};
  for (const a of topApps) appById[a.id] = a;
  const accrued = (fees._sum.deltaMicros ?? 0n) + (revenue._sum.deltaMicros ?? 0n);
  const burnedMicros = burned._sum.usdMicros ?? 0n;
  const burnedUnits = snapshot ? BigInt(snapshot.burnedUnits) : 0n;
  return {
    launched: snapshot !== null,
    token: snapshot
      ? {
          address: snapshot.address,
          name: snapshot.name,
          symbol: snapshot.symbol,
          phase: snapshot.phase,
          curveAddress: snapshot.curveAddress,
          poolId: snapshot.phase >= 2 ? snapshot.poolId : null,
          progress: snapshot.progress,
          priceUsd: snapshot.priceUsd,
          priceEth: snapshot.priceEth,
          mcapUsd: snapshot.mcapUsd,
          totalSupplyUnits: snapshot.totalSupplyUnits,
          burnedUnits: snapshot.burnedUnits,
          burnedPct: pctOfSupply(burnedUnits),
          ponsUrl: ponsUrl(snapshot.address),
          explorerUrl: explorerTokenUrl(snapshot.address, env.BLOCKSCOUT_URL),
        }
      : null,
    ledger: { accruedMicros: accrued.toString(), burnedMicros: burnedMicros.toString(), pendingMicros: (balance._sum.deltaMicros ?? 0n).toString() },
    feeShareBps: FEE_SPLIT_BPS.PYRE_TOKEN,
    revenueShareBps: REVENUE_SPLIT_BPS.PYRE_TOKEN,
    stakes: {
      totalUnits: big(staked._sum.amount).toString(),
      stakers: Number(stakers[0]?.count ?? 0n),
      earnedMicros: (staked._sum.earnedMicros ?? 0n).toString(),
    },
    burns: burns.map((b) => {
      const units = big(b.burnedUnits ?? b.tokensBurned);
      return {
        id: b.id,
        usdMicros: b.usdMicros.toString(),
        ethWei: big(b.ethWei).toString(),
        tokensBoughtUnits: big(b.tokensBought).toString(),
        burnedUnits: units.toString(),
        burnedPctOfSupply: pctOfSupply(units),
        swapTx: b.swapTx as PyrePageDto["burns"][number]["swapTx"],
        burnTx: b.burnTx as PyrePageDto["burns"][number]["burnTx"],
        attestTx: b.attestTx as PyrePageDto["burns"][number]["attestTx"],
        attestHash: b.attestHash,
        createdAt: (b.completedAt ?? b.createdAt).toISOString(),
      };
    }),
    proposals: { open: proposalsOpen, shipped: proposalsShipped },
    topStakes: top.flatMap((t) => {
      const a = appById[t.appId];
      return a ? [{ appId: a.id, appSlug: a.slug, appName: a.name, appTicker: a.ticker, units: big(t._sum.amount).toString(), stakers: t._count._all }] : [];
    }),
  };
};

/** A staker's own positions are capped: a wallet cannot force an unbounded page. */
const MY_STAKES_MAX = 100;

pyre.get(
  "/",
  optionalAuth,
  wrap(async (req, res) => {
    const overview = await cached("pyre.overview", 30_000, loadOverview, [APPS_TAG]);
    const wallet = req.user?.wallet as Address | undefined;
    if (!wallet) {
      sendCached(res, { ...overview, viewer: null } satisfies PyrePageDto, { maxAge: 30, swr: 120 });
      return;
    }
    const [mine, units] = await Promise.all([
      db.pyreStake.findMany({ where: { wallet }, orderBy: { createdAt: "desc" }, take: MY_STAKES_MAX }),
      pyreBalance(wallet),
    ]);
    const mineApps = mine.length > 0 ? await db.app.findMany({ where: { id: { in: mine.map((s) => s.appId) } }, select: APP_REF }) : [];
    const appById: Record<string, AppRef> = {};
    for (const a of mineApps) appById[a.id] = a;
    let stakedUnits = 0n;
    let earnedMicros = 0n;
    for (const s of mine) {
      if (s.withdrawnAt) continue;
      stakedUnits += big(s.amount);
      earnedMicros += s.earnedMicros;
    }
    const body: PyrePageDto = {
      ...overview,
      viewer: {
        units: units.toString(),
        stakedUnits: stakedUnits.toString(),
        earnedMicros: earnedMicros.toString(),
        canPropose: units >= PLATFORM_PROPOSAL_MIN_HOLD,
        stakes: mine.map((s) => stakeDto(s, appById[s.appId])),
      },
    };
    sendCached(res, body, { maxAge: 0, private: true });
  }),
);

/** Moves $PYRE from the caller's custodial wallet into the treasury stake vault. */
export const pyreStakeHandler = async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  if (!env.PYRE_TOKEN) throw new HttpError(503, "pyre_not_launched");
  if (!user.wallet) throw new HttpError(400, "wallet_required");
  const wallet = user.wallet as Address;
  const body = parse(PyreStakeBody, req.body);
  const app = await prisma.app.findUnique({ where: { id: body.appId }, select: { id: true, slug: true, name: true, ticker: true, status: true } });
  if (!app) throw new HttpError(404, "app_not_found");
  if (app.status !== "LIVE" && app.status !== "DORMANT") throw new HttpError(409, "app_not_live");
  const amount = decimalToUnits(body.amount.toString(), TOKEN_DECIMALS);
  if (amount <= 0n) throw new HttpError(400, "invalid_amount");
  const [balance, gas] = await Promise.all([pyreBalance(wallet), custodialEthBalance(wallet)]);
  if (balance < amount) throw new HttpError(400, "insufficient_balance", { haveUnits: balance.toString(), needUnits: amount.toString() });
  if (gas < GAS_RESERVE_WEI) throw new HttpError(400, "insufficient_gas", { haveWei: gas.toString(), needWei: GAS_RESERVE_WEI.toString() });
  let depositTx: string;
  try {
    depositTx = await transferErc20(custodialAccount(user), env.PYRE_TOKEN, TREASURY_WALLET, amount);
  } catch (err) {
    logger.error({ err, appId: app.id, userId: user.id }, "pyre stake transfer failed");
    throw new HttpError(502, "stake_failed");
  }
  const stake = await prisma.pyreStake.create({ data: { wallet, appId: app.id, amount: dec(amount), depositTx } });
  res.status(201).json(stakeDto(stake, app));
};

pyre.post("/stake", requireAuth, wrap(pyreStakeHandler));

const UnstakeBody = z.object({ stakeId: z.string().min(1) });

pyre.post(
  "/unstake",
  requireAuth,
  wrap(async (req, res) => {
    const user = req.user!;
    if (!env.PYRE_TOKEN) throw new HttpError(503, "pyre_not_launched");
    const body = parse(UnstakeBody, req.body);
    const stake = await prisma.pyreStake.findUnique({ where: { id: body.stakeId } });
    if (!stake) throw new HttpError(404, "stake_not_found");
    if (stake.wallet !== user.wallet) throw new HttpError(403, "forbidden");
    if (stake.withdrawnAt) throw new HttpError(409, "already_withdrawn");
    // Mark first so a double-submit cannot trigger two payouts. Rolled back only when the transfer
    // provably moved nothing; a broadcast with an unreadable receipt may still mine, so the stake
    // stays withdrawn with its tx and the runner's PAYOUTS reconcile settles it from the receipt.
    const marked = await prisma.pyreStake.updateMany({ where: { id: stake.id, withdrawnAt: null }, data: { withdrawnAt: new Date() } });
    if (marked.count === 0) throw new HttpError(409, "already_withdrawn");
    let withdrawTx: string;
    try {
      withdrawTx = await transferErc20(TREASURY_ACCOUNT, env.PYRE_TOKEN, stake.wallet as Address, big(stake.amount));
    } catch (err) {
      if (err instanceof TransactionUnconfirmedError) {
        logger.error({ err, stakeId: stake.id, txHash: err.hash }, "unstake transfer unconfirmed; stake kept withdrawn for reconcile");
        await prisma.pyreStake.update({ where: { id: stake.id }, data: { withdrawTx: err.hash } });
        await writeAudit({
          actorId: user.id,
          actor: `user:${user.id}`,
          action: "PAYOUT_UNCONFIRMED",
          targetType: "PyreStake",
          targetId: stake.id,
          meta: { kind: "PYRE_UNSTAKE", txHash: err.hash, wallet: stake.wallet, amount: big(stake.amount).toString() },
        }).catch((e: unknown) => logger.error({ err: e, stakeId: stake.id }, "unstake unconfirmed audit write failed"));
        throw new HttpError(502, "withdraw_unconfirmed", { txHash: err.hash });
      }
      logger.error({ err, stakeId: stake.id }, "unstake transfer failed");
      await prisma.pyreStake.update({ where: { id: stake.id }, data: { withdrawnAt: null } });
      throw new HttpError(502, "withdraw_failed");
    }
    const updated = await prisma.pyreStake.update({ where: { id: stake.id }, data: { withdrawTx } });
    await writeAudit({
      actorId: user.id,
      actor: `user:${user.id}`,
      action: "PYRE_UNSTAKE",
      targetType: "PyreStake",
      targetId: stake.id,
      meta: { appId: stake.appId, wallet: stake.wallet, amount: big(stake.amount).toString(), earnedMicros: stake.earnedMicros.toString(), withdrawTx },
      // The transfer already settled on chain; never fail the response on an audit write.
    }).catch((err: unknown) => logger.error({ err, stakeId: stake.id }, "unstake audit write failed"));
    const app = await prisma.app.findUnique({ where: { id: stake.appId }, select: APP_REF });
    res.json(stakeDto(updated, app));
  }),
);

/** Below $1 a staker-rewards claim is not worth the transaction fee. */
const MIN_STAKER_CLAIM_MICROS = 1_000_000n;

/**
 * Pays a staker their accrued rewards (`earnedMicros` summed across active stakes) in ETH from the
 * treasury, without unstaking. Clears the earned amounts first (inside a transaction) so a concurrent
 * claim cannot double-pay, and restores them if the payout fails — same guarantee as the launcher claim.
 */
export const claimStakerRewardsHandler = async (req: Request, res: Response): Promise<void> => {
  const u = req.user!;
  if (!u.wallet) throw new HttpError(400, "wallet_required");

  // Read-and-clear atomically: the next concurrent claim sees zero and pays nothing.
  const stakes = await prisma.$transaction(async (tx) => {
    const rows = await tx.pyreStake.findMany({
      where: { wallet: u.wallet!, withdrawnAt: null, earnedMicros: { gt: 0n } },
      select: { id: true, appId: true, earnedMicros: true },
    });
    if (rows.length > 0) {
      await tx.pyreStake.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { earnedMicros: 0n } });
    }
    return rows;
  });

  const total = stakes.reduce((acc, s) => acc + s.earnedMicros, 0n);
  // Increment, never set: a fee sweep may have credited `earnedMicros` since the clear above, and
  // an absolute restore would overwrite that share.
  const restore = async (): Promise<void> => {
    for (const s of stakes) await prisma.pyreStake.update({ where: { id: s.id }, data: { earnedMicros: { increment: s.earnedMicros } } });
  };
  if (total < MIN_STAKER_CLAIM_MICROS) {
    await restore();
    throw new HttpError(400, "nothing_to_claim", { claimableMicros: total.toString() });
  }

  const ethPriceUsd = await getEthPriceUsd();
  const wei = weiFromUsdMicros(total, ethPriceUsd);
  if (wei <= 0n) {
    await restore();
    throw new HttpError(400, "nothing_to_claim", { claimableMicros: total.toString() });
  }

  // Ledger rows per app + the treasury debit, written once the payout is known to have landed.
  const byApp: Record<string, bigint> = {};
  for (const s of stakes) byApp[s.appId] = (byApp[s.appId] ?? 0n) + s.earnedMicros;

  let txHash: string;
  try {
    txHash = await transferEth(TREASURY_ACCOUNT, u.wallet as Address, wei);
  } catch (err) {
    if (err instanceof TransactionUnconfirmedError) {
      // The rewards stay cleared; the reconcile pass writes the ledger rows on success or restores
      // the stakes on revert.
      logger.error({ err, userId: u.id, txHash: err.hash }, "staker rewards payout unconfirmed; left cleared for reconcile");
      await writeAudit({
        actorId: u.id,
        actor: `user:${u.id}`,
        action: "PAYOUT_UNCONFIRMED",
        targetType: "User",
        targetId: u.id,
        meta: {
          kind: "PYRE_CLAIM",
          txHash: err.hash,
          userId: u.id,
          usdMicros: total.toString(),
          wei: wei.toString(),
          stakes: stakes.map((s) => ({ id: s.id, appId: s.appId, earnedMicros: s.earnedMicros.toString() })),
        },
      }).catch((e: unknown) => logger.error({ err: e, userId: u.id }, "staker rewards unconfirmed audit write failed"));
      throw new HttpError(502, "claim_unconfirmed", { txHash: err.hash });
    }
    await restore();
    logger.error({ err, userId: u.id }, "staker rewards payout failed");
    throw new HttpError(502, "claim_payout_failed");
  }

  await prisma.ledgerEntry.createMany({
    data: [
      ...Object.entries(byApp).map(([appId, micros]) => ({
        account: `STAKERS:${appId}`,
        deltaMicros: -micros,
        refType: "Payout",
        refId: u.id,
        memo: `staker rewards ${txHash}`,
      })),
      { account: "TREASURY", deltaMicros: -total, refType: "Payout", refId: u.id, memo: `staker rewards ${txHash}` },
    ],
  });
  await writeAudit({
    actorId: u.id,
    actor: `user:${u.id}`,
    action: "PYRE_CLAIM",
    targetType: "PyreStake",
    targetId: u.id,
    meta: { usdMicros: total.toString(), wei: wei.toString(), txHash, stakeCount: stakes.length },
  }).catch((err: unknown) => logger.error({ err, userId: u.id }, "staker rewards audit write failed"));

  res.json({ usdMicros: total.toString(), wei: wei.toString(), txHash, explorerUrl: explorerTxUrl(txHash as `0x${string}`) });
};
pyre.post("/claim", requireAuth, wrap(claimStakerRewardsHandler));
