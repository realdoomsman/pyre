import { Router } from "express";
import type { Request, Response } from "express";
import type { Address } from "viem";
import { big, prisma } from "@pyre/db";
import { getErc20Balance, getEthPriceUsd, relayUsdgAuthorization, signUsdgAuthorization, transferEth, explorerTxUrl } from "@pyre/chain";
import {
  LAUNCH_RATE_LIMIT_PER_DAY,
  TradeBody,
  WITHDRAW_DAILY_CAP_USD,
  WithdrawBody,
  ethToWei,
  usdMicrosFromWei,
  weiFromUsdMicros,
  type BalancesDto,
  type MeDto,
  type PositionDto,
  type TradeResultDto,
  type WithdrawResultDto,
} from "@pyre/shared";
import { reputationTier, requireAuth } from "../lib/auth.js";
import { writeAudit } from "../lib/audit.js";
import { cached } from "../lib/cache.js";
import { custodialAccount, custodialEthBalance, custodialUsdgBalance, GAS_RESERVE_WEI } from "../lib/custodial.js";
import { APP_SUMMARY_SELECT, appExtrasByApp, appSummary, launchDto, pctOfSupply, tokens, usd } from "../lib/dto.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { sendCached } from "../lib/http.js";
import { launchesLast24h } from "../lib/launch.js";
import { logger } from "../lib/logger.js";
import { db } from "../lib/metrics.js";
import { executeTrade, quoteTrade, recordTrade } from "../lib/trade.js";
import { TREASURY_ACCOUNT } from "../lib/treasury.js";
import { tradeDto } from "../lib/dto.js";
import { SUPPLY_BASE_UNITS } from "../lib/votes.js";
import { env } from "../env.js";

export const me = Router();

/** Dashboards are per-viewer: never shared-cacheable, and every list has a hard ceiling. */
const PAGE_MAX = 100;

/** A launcher's unclaimed fee share = the running balance of their LAUNCHER:<userId> ledger account. */
const launcherClaimableMicros = async (userId: string): Promise<bigint> => {
  const agg = await db.ledgerEntry.aggregate({ where: { account: `LAUNCHER:${userId}` }, _sum: { deltaMicros: true } });
  return agg._sum.deltaMicros ?? 0n;
};

/** ETH + USDG of the custodial wallet, read fresh (a few seconds of cache absorbs a page's parallel calls). */
export const balancesOf = async (wallet: Address): Promise<BalancesDto> => {
  const [ethWei, usdgUnits, ethPriceUsd] = await Promise.all([
    cached(`bal:eth:${wallet}`, 3_000, () => custodialEthBalance(wallet)),
    cached(`bal:usdg:${wallet}`, 3_000, () => custodialUsdgBalance(wallet)),
    getEthPriceUsd(),
  ]);
  return { ethWei: ethWei.toString(), usdgUnits: usdgUnits.toString(), ethPriceUsd };
};

/**
 * Coin positions across the viewer's wallets (custodial + proven external). Rows come from the
 * holder snapshot; the custodial wallet's balances are re-read from chain (one multicall) so a
 * trade made seconds ago shows without waiting for the next holders refresh.
 */
const positionsOf = async (wallets: Address[], ethPriceUsd: number): Promise<PositionDto[]> => {
  if (wallets.length === 0) return [];
  const rows = await db.holderBalance.findMany({
    where: { wallet: { in: wallets }, amount: { gt: 0 }, app: { tokenAddress: { not: null } } },
    orderBy: { amount: "desc" },
    take: PAGE_MAX,
    select: { appId: true, wallet: true, amount: true, app: { select: APP_SUMMARY_SELECT } },
  });
  const live = await Promise.all(
    rows.map((r) =>
      r.wallet === wallets[0]
        ? cached(`bal:tok:${r.app.tokenAddress}:${r.wallet}`, 10_000, () => getErc20Balance(r.app.tokenAddress as Address, r.wallet as Address)).catch(() => big(r.amount))
        : Promise.resolve(big(r.amount)),
    ),
  );
  // One position per app: sum across the viewer's wallets.
  const byApp: Record<string, { app: (typeof rows)[number]["app"]; units: bigint }> = {};
  rows.forEach((r, i) => {
    const cur = byApp[r.appId];
    if (cur) cur.units += live[i]!;
    else byApp[r.appId] = { app: r.app, units: live[i]! };
  });
  const extras = await appExtrasByApp(Object.keys(byApp));
  return Object.values(byApp)
    .filter((p) => p.units > 0n)
    .map((p) => {
      const remaining = SUPPLY_BASE_UNITS - big(p.app.burnedTokens);
      return {
        app: appSummary(p.app, extras[p.app.id]!, ethPriceUsd),
        units: p.units.toString(),
        valueUsd: tokens(p.units) * p.app.priceUsd,
        shareOfRemainingPct: remaining > 0n ? Number((p.units * 1_000_000n) / remaining) / 10_000 : pctOfSupply(p.units),
      };
    });
};

const WITHDRAW_CAP_MICROS = BigInt(WITHDRAW_DAILY_CAP_USD) * 1_000_000n;

/** UTC calendar day key, e.g. "2026-09-24" — the window the withdrawal cap resets on. */
const utcDay = (): string => new Date().toISOString().slice(0, 10);

me.get(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    const u = req.user!;
    if (!u.wallet) throw new HttpError(400, "wallet_required");
    const wallet = u.wallet as Address;
    const tier = reputationTier(u.reputation);
    const wallets: Address[] = u.authWallet && u.authWallet !== u.wallet ? [wallet, u.authWallet as Address] : [wallet];
    const [balances, launched, claimableMicros, stakerMicros, launchesToday, unread, usedToday] = await Promise.all([
      balancesOf(wallet),
      db.app.findMany({ where: { launcherId: u.id }, orderBy: { createdAt: "desc" }, take: PAGE_MAX }),
      launcherClaimableMicros(u.id),
      db.pyreStake.aggregate({ where: { wallet: { in: wallets }, withdrawnAt: null }, _sum: { earnedMicros: true } }),
      launchesLast24h(u.id),
      db.notification.count({ where: { userId: u.id, readAt: null } }),
      db.dailyWithdraw.findUnique({ where: { userId_day: { userId: u.id, day: utcDay() } } }),
    ]);
    const positions = await positionsOf(wallets, balances.ethPriceUsd);
    const used = usedToday?.usedMicros ?? 0n;
    const body: MeDto = {
      user: {
        id: u.id,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        xHandle: u.xHandle,
        isAdmin: u.isAdmin,
        reputation: u.reputation,
        tier,
        createdAt: u.createdAt.toISOString(),
      },
      wallet,
      authWallet: (u.authWallet as Address | null) ?? null,
      balances,
      positions,
      launched: launched.map(launchDto),
      claimable: {
        launcherMicros: claimableMicros.toString(),
        launcherWei: (balances.ethPriceUsd > 0 && claimableMicros > 0n ? weiFromUsdMicros(claimableMicros, balances.ethPriceUsd) : 0n).toString(),
        stakerMicros: (stakerMicros._sum.earnedMicros ?? 0n).toString(),
      },
      launchesToday,
      launchLimitPerDay: LAUNCH_RATE_LIMIT_PER_DAY[tier],
      notifications: { unread },
      withdrawRemainingMicros: (used >= WITHDRAW_CAP_MICROS ? 0n : WITHDRAW_CAP_MICROS - used).toString(),
    };
    sendCached(res, body, { maxAge: 0, private: true });
  }),
);

me.get(
  "/balances",
  requireAuth,
  wrap(async (req, res) => {
    const u = req.user!;
    if (!u.wallet) throw new HttpError(400, "wallet_required");
    sendCached(res, await balancesOf(u.wallet as Address), { maxAge: 0, private: true });
  }),
);

/** Below $1 a claim is not worth the transaction fee. */
const MIN_CLAIM_MICROS = 1_000_000n;

/**
 * Pays a launcher their unclaimed fee share (`LAUNCHER:<userId>` ledger balance) in ETH from the
 * treasury. Guards against a double-claim by writing the clearing ledger entry first and rolling it
 * back if the transfer fails, exactly like the unstake path.
 */
export const claimHandler = async (req: Request, res: Response): Promise<void> => {
  const u = req.user!;
  if (!u.wallet) throw new HttpError(400, "wallet_required");
  const claimable = await launcherClaimableMicros(u.id);
  if (claimable < MIN_CLAIM_MICROS) throw new HttpError(400, "nothing_to_claim", { claimableMicros: claimable.toString() });

  // Zero the balance first so a concurrent claim sees nothing; undo it if anything below fails.
  const marker = await prisma.ledgerEntry.create({
    data: { account: `LAUNCHER:${u.id}`, deltaMicros: -claimable, refType: "Payout", refId: u.id, memo: "fees claim (pending)" },
  });
  const recheck = await launcherClaimableMicros(u.id);
  if (recheck < 0n) {
    await prisma.ledgerEntry.delete({ where: { id: marker.id } });
    throw new HttpError(409, "claim_in_progress");
  }

  const ethPriceUsd = await getEthPriceUsd();
  const wei = weiFromUsdMicros(claimable, ethPriceUsd);
  if (wei <= 0n) {
    await prisma.ledgerEntry.delete({ where: { id: marker.id } });
    throw new HttpError(400, "nothing_to_claim", { claimableMicros: claimable.toString() });
  }

  let txHash: string;
  try {
    txHash = await transferEth(TREASURY_ACCOUNT, u.wallet as Address, wei);
  } catch (err) {
    await prisma.ledgerEntry.delete({ where: { id: marker.id } });
    logger.error({ err, userId: u.id }, "fees claim payout failed");
    throw new HttpError(502, "claim_payout_failed");
  }

  await prisma.ledgerEntry.update({ where: { id: marker.id }, data: { memo: `fees claim ${txHash}` } });
  await prisma.ledgerEntry.create({
    data: { account: "TREASURY", deltaMicros: -claimable, refType: "Payout", refId: u.id, memo: `fees claim ${txHash}` },
  });
  await writeAudit({
    actorId: u.id,
    actor: `user:${u.id}`,
    action: "FEES_CLAIM",
    targetType: "User",
    targetId: u.id,
    meta: { usdMicros: claimable.toString(), wei: wei.toString(), txHash, wallet: u.wallet },
  }).catch((err: unknown) => logger.error({ err, userId: u.id }, "fees claim audit write failed"));

  res.json({ usdMicros: claimable.toString(), wei: wei.toString(), txHash, explorerUrl: explorerTxUrl(txHash as `0x${string}`) });
};
me.post("/claim", requireAuth, wrap(claimHandler));

const MIN_WITHDRAW_WEI = 100_000_000_000_000n; // 0.0001 ETH
const MIN_WITHDRAW_USDG_UNITS = 100_000n; // $0.10
/** An EIP-3009 authorization the treasury relays must be used within this window. */
const USDG_AUTH_VALID_SECONDS = 10 * 60;

/**
 * Atomically reserve `addUsdMicros` against the caller's per-day withdrawal cap (compromise
 * blast-radius guard). The reservation is a single conditional increment — one UPDATE guarded by
 * `used + add <= cap` — so concurrent withdrawals serialize on the row and none can out-read a stale
 * total to breach the cap. Reserved BEFORE the transfer and durable (a DB row, not a best-effort
 * audit write); the returned handle releases the reservation only if the transfer then fails.
 */
const reserveDailyWithdraw = async (userId: string, addUsdMicros: bigint): Promise<() => Promise<void>> => {
  const day = utcDay();
  await prisma.dailyWithdraw.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, usedMicros: 0n },
    update: {},
  });
  const reserved = await prisma.dailyWithdraw.updateMany({
    where: { userId, day, usedMicros: { lte: WITHDRAW_CAP_MICROS - addUsdMicros } },
    data: { usedMicros: { increment: addUsdMicros } },
  });
  if (reserved.count === 0) {
    const row = await prisma.dailyWithdraw.findUnique({ where: { userId_day: { userId, day } } });
    throw new HttpError(400, "daily_limit_exceeded", {
      capUsd: WITHDRAW_DAILY_CAP_USD,
      usedUsd: usd(row?.usedMicros ?? 0n),
      requestedUsd: usd(addUsdMicros),
    });
  }
  return async () => {
    await prisma.dailyWithdraw
      .updateMany({ where: { userId, day }, data: { usedMicros: { decrement: addUsdMicros } } })
      .catch((err: unknown) => logger.error({ err, userId }, "withdraw cap release failed"));
  };
};

/**
 * Server-signs a transfer out of the caller's custodial wallet to any address. ETH is a plain
 * value transfer (the wallet keeps `GAS_RESERVE_WEI`); USDG is an EIP-3009 authorization signed
 * by the custodial key and relayed by the treasury, so a USDG-only wallet never needs ETH for gas.
 */
export const withdrawHandler = async (req: Request, res: Response): Promise<void> => {
  const u = req.user!;
  if (!u.wallet) throw new HttpError(400, "wallet_required");
  const wallet = u.wallet as Address;
  const body = parse(WithdrawBody, req.body);
  if (body.to === wallet) throw new HttpError(400, "cannot_withdraw_to_self");
  const account = custodialAccount(u);

  if (body.asset === "ETH") {
    const wei = ethToWei(body.amount);
    if (wei < MIN_WITHDRAW_WEI) throw new HttpError(400, "amount_too_small", { minWei: MIN_WITHDRAW_WEI.toString() });
    const balance = await custodialEthBalance(wallet);
    const need = wei + GAS_RESERVE_WEI;
    if (balance < need) throw new HttpError(400, "insufficient_balance", { haveWei: balance.toString(), needWei: need.toString() });
    const usdMicros = usdMicrosFromWei(wei, await getEthPriceUsd());
    const releaseCap = await reserveDailyWithdraw(u.id, usdMicros);
    let txHash: string;
    try {
      txHash = await transferEth(account, body.to, wei);
    } catch (err) {
      await releaseCap();
      logger.error({ err, userId: u.id }, "ETH withdraw failed");
      throw new HttpError(502, "withdraw_failed");
    }
    await writeAudit({
      actorId: u.id,
      actor: `user:${u.id}`,
      action: "WALLET_WITHDRAW",
      targetType: "User",
      targetId: u.id,
      meta: { asset: "ETH", to: body.to, wei: wei.toString(), usdMicros: usdMicros.toString(), txHash },
    }).catch((err: unknown) => logger.error({ err, userId: u.id }, "withdraw audit write failed"));
    const out: WithdrawResultDto = {
      asset: "ETH",
      to: body.to,
      amount: wei.toString(),
      txHash: txHash as WithdrawResultDto["txHash"],
      explorerUrl: explorerTxUrl(txHash as `0x${string}`),
      balances: await balancesOf(wallet),
    };
    res.json(out);
    return;
  }

  const units = BigInt(Math.round(body.amount * 1e6));
  if (units < MIN_WITHDRAW_USDG_UNITS) throw new HttpError(400, "amount_too_small", { minUnits: MIN_WITHDRAW_USDG_UNITS.toString() });
  const balance = await custodialUsdgBalance(wallet);
  if (balance < units) throw new HttpError(400, "insufficient_balance", { haveUnits: balance.toString(), needUnits: units.toString() });
  // USDG is a dollar stablecoin: one unit is one USD micro against the daily cap.
  const releaseCap = await reserveDailyWithdraw(u.id, units);
  let txHash: string;
  try {
    const auth = await signUsdgAuthorization(account, {
      to: body.to,
      units,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + USDG_AUTH_VALID_SECONDS),
    });
    txHash = await relayUsdgAuthorization(auth);
  } catch (err) {
    await releaseCap();
    logger.error({ err, userId: u.id }, "USDG withdraw failed");
    throw new HttpError(502, "withdraw_failed");
  }
  await writeAudit({
    actorId: u.id,
    actor: `user:${u.id}`,
    action: "WALLET_WITHDRAW",
    targetType: "User",
    targetId: u.id,
    meta: { asset: "USDG", to: body.to, units: units.toString(), usdMicros: units.toString(), txHash },
  }).catch((err: unknown) => logger.error({ err, userId: u.id }, "withdraw audit write failed"));
  const out: WithdrawResultDto = {
    asset: "USDG",
    to: body.to,
    amount: units.toString(),
    txHash: txHash as WithdrawResultDto["txHash"],
    explorerUrl: explorerTxUrl(txHash as `0x${string}`),
    balances: await balancesOf(wallet),
  };
  res.json(out);
};
me.post("/withdraw", requireAuth, wrap(withdrawHandler));

const TRADE_APP_SELECT = { id: true, slug: true, tokenAddress: true, curveAddress: true, launchPhase: true, status: true, priceUsd: true } as const;

const tradeApp = async (slug: string) => {
  const app = await prisma.app.findUnique({ where: { slug }, select: TRADE_APP_SELECT });
  if (!app || !app.tokenAddress) throw new HttpError(404, "app_not_found");
  return app;
};

/** `POST /v1/me/quote` — read-only quote for the caller's custodial wallet (snipe tax is recipient-keyed). */
me.post(
  "/quote",
  requireAuth,
  wrap(async (req, res) => {
    const u = req.user!;
    if (!u.wallet) throw new HttpError(400, "wallet_required");
    const body = parse(TradeBody, req.body);
    const { quote } = await quoteTrade(await tradeApp(body.slug), u.wallet as Address, body);
    sendCached(res, quote, { maxAge: 0, private: true });
  }),
);

/** `POST /v1/me/trade` — executes a custodial buy/sell; returns the fill, the quote it was checked against and fresh balances. */
export const tradeHandler = async (req: Request, res: Response): Promise<void> => {
  const u = req.user!;
  if (!u.wallet) throw new HttpError(400, "wallet_required");
  const body = parse(TradeBody, req.body);
  const app = await tradeApp(body.slug);
  const { quote, trade } = await executeTrade(app, u, body);
  const row = await recordTrade(app, u.wallet as Address, body.side, quote.venue, trade);
  await writeAudit({
    actorId: u.id,
    actor: `user:${u.id}`,
    action: "CUSTODIAL_TRADE",
    targetType: "App",
    targetId: app.id,
    meta: { side: body.side, venue: quote.venue, txHash: trade.txHash, tokenUnits: trade.tokenUnits.toString(), quoteWei: trade.quoteWei.toString() },
  }).catch((err: unknown) => logger.error({ err, userId: u.id }, "trade audit write failed"));
  const out: TradeResultDto = { trade: tradeDto(row), quote, balances: await balancesOf(u.wallet as Address) };
  res.json(out);
};
me.post("/trade", requireAuth, wrap(tradeHandler));

/** Where the caller deposits: their custodial address plus the chain facts a wallet needs to send to it. */
me.get(
  "/deposit",
  requireAuth,
  wrap(async (req, res) => {
    const u = req.user!;
    if (!u.wallet) throw new HttpError(400, "wallet_required");
    sendCached(
      res,
      { address: u.wallet, chainId: env.CHAIN_ID, usdg: env.USDG_ADDRESS, explorerUrl: `${env.BLOCKSCOUT_URL}/address/${u.wallet}` },
      { maxAge: 0, private: true },
    );
  }),
);
