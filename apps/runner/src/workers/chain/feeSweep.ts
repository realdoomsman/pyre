import { Worker } from "bullmq";
import type { Logger } from "pino";
import { big, dec, prisma, type Prisma } from "@pyre/db";
import { ITERATION_BUDGET_USD, VENUES, explorerTxUrl, splitFees, usdMicrosFromNative, usdMicrosFromWei } from "@pyre/shared";
import { accruingFees, adapterFor, claimEscrow, getEthBalance, getEthPriceUsd, readLaunch, solanaEnabled, sweepCreatorFees, transferEth, treasury } from "@pyre/chain";
import type { Address, Hash } from "viem";
import { audit } from "../../lib/audit.js";
import { withLock } from "../../lib/lock.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { chainWorkerEnv } from "./env.js";
import { syncLaunchPhase } from "./launchState.js";
import { isPaused } from "./money.js";
import { publishEvent, publishGlobal } from "./publish.js";
import { APP_GAS_LOW_WEI, APP_GAS_RESERVE_WEI, TREASURY_FLOOR_WEI, appWallet, topUpFromTreasury } from "./wallet.js";

/** Claimed ETH below this stays in the app wallet until the next claim; moving dust costs more than it is worth. */
const MIN_MOVE_WEI = 100_000_000_000_000n; // 0.0001 ETH
/** Native float a non-EVM app wallet keeps for its own claim transactions (rent exemption + fees on Solana). */
const VENUE_WALLET_FLOAT: Record<string, bigint> = { solana: 20_000_000n };

export type SweepApp = Prisma.AppGetPayload<{ include: { launcher: { select: { id: true; wallet: true } }; forkOf: { select: { id: true; status: true } } } }>;
export const SWEEP_APP_INCLUDE = { launcher: { select: { id: true, wallet: true } }, forkOf: { select: { id: true, status: true } } } as const;

export interface FeeCredit {
  feeEventId: string;
  budgetMicros: bigint;
  buildMicros: bigint;
  usdMicros: bigint;
}

/**
 * Records one escrow claim: FeeEvent (unique on the claim tx), budget credit, ledger rows, fork
 * royalty to the parent and staker payouts. Returns null when that tx was already recorded, so
 * the sweep pass and the reconcile repair can both call it safely.
 */
export async function recordCreatorFee(app: SweepApp, wei: bigint, txHash: string, ethPriceUsd: number, log: Logger): Promise<FeeCredit | null> {
  if (await prisma.feeEvent.findUnique({ where: { txHash }, select: { id: true } })) return null;
  const usdMicros = usdMicrosFromNative(wei, ethPriceUsd, VENUES[app.launchpad].native.decimals);
  const parent = app.forkOf && app.forkOf.status !== "KILLED" && app.forkOf.status !== "FAILED" ? app.forkOf : null;
  const stakes = await prisma.pyreStake.findMany({ where: { appId: app.id, withdrawnAt: null, amount: { gt: 0 } }, select: { id: true, amount: true } });
  const split = splitFees(usdMicros, parent !== null, stakes.length > 0, app.chain);

  const credit = await prisma.$transaction(async (tx) => {
    const fee = await tx.feeEvent.create({
      data: {
        appId: app.id,
        source: "CREATOR_FEE",
        wei: dec(wei),
        ethPriceUsd,
        usdMicros: split.usdMicros,
        buildMicros: split.buildMicros,
        pyreMicros: split.pyreMicros,
        coinBurnMicros: split.coinBurnMicros,
        launcherMicros: split.launcherMicros,
        upstreamMicros: split.upstreamMicros,
        creditsMicros: split.creditsMicros,
        txHash,
      },
    });
    const updated = await tx.app.update({
      where: { id: app.id },
      data: { budgetMicros: { increment: split.buildMicros }, feesWei: { increment: dec(wei) } },
      select: { budgetMicros: true },
    });
    // The 25% burn leg: PYRE_TOKEN on Robinhood Chain, the coin's own COINBURN account elsewhere.
    const ledger: Prisma.LedgerEntryCreateManyInput[] = [
      { account: `BUILD:${app.id}`, deltaMicros: split.buildMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" },
      app.chain === "robinhood"
        ? { account: "PYRE_TOKEN", deltaMicros: split.pyreMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" }
        : { account: `COINBURN:${app.id}`, deltaMicros: split.coinBurnMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" },
      { account: `LAUNCHER:${app.launcherId}`, deltaMicros: split.launcherMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" },
    ];
    if (split.creditsMicros > 0n) {
      ledger.push({ account: `CREDITS:${app.id}`, deltaMicros: split.creditsMicros, refType: "FeeEvent", refId: fee.id, memo: "credit funding" });
    }
    if (parent && split.upstreamMicros > 0n) {
      // The royalty row carries no txHash of its own: what makes it idempotent is the check-then-act
      // `findUnique` on the child's claim tx at the top of this function plus the unique constraint
      // on the child FeeEvent inside this transaction. Replaying `recordCreatorFee` for a recorded tx
      // returns null before reaching here; a lost race between the sweep pass and the reconcile
      // repair fails the child's unique insert and rolls this whole transaction back (no double credit).
      const royaltyWei = (wei * split.upstreamMicros) / (usdMicros > 0n ? usdMicros : 1n);
      const royalty = await tx.feeEvent.create({
        data: {
          appId: parent.id,
          source: "FORK_ROYALTY",
          wei: dec(royaltyWei),
          ethPriceUsd,
          usdMicros: split.upstreamMicros,
          buildMicros: split.upstreamMicros,
          pyreMicros: 0n,
          launcherMicros: 0n,
        },
      });
      await tx.app.update({ where: { id: parent.id }, data: { budgetMicros: { increment: split.upstreamMicros } } });
      ledger.push({ account: `BUILD:${parent.id}`, deltaMicros: split.upstreamMicros, refType: "FeeEvent", refId: royalty.id, memo: `fork royalty from ${app.id}` });
    }
    if (split.stakersMicros > 0n) {
      const amounts = stakes.map((s) => big(s.amount));
      const totalStaked = amounts.reduce((acc, a) => acc + a, 0n);
      let distributed = 0n;
      for (let i = 0; i < stakes.length; i++) {
        const stake = stakes[i]!;
        const share = i === stakes.length - 1 ? split.stakersMicros - distributed : (split.stakersMicros * amounts[i]!) / totalStaked;
        distributed += share;
        if (share > 0n) await tx.pyreStake.update({ where: { id: stake.id }, data: { earnedMicros: { increment: share } } });
      }
      ledger.push({ account: `STAKERS:${app.id}`, deltaMicros: split.stakersMicros, refType: "FeeEvent", refId: fee.id, memo: "staker share of launcher cut" });
    }
    await tx.ledgerEntry.createMany({ data: ledger });
    log.info({ feeEventId: fee.id, wei: wei.toString(), usdMicros: usdMicros.toString(), split }, "creator fee recorded");
    return { feeEventId: fee.id, budgetMicros: updated.budgetMicros, buildMicros: split.buildMicros, usdMicros };
  });
  await audit({
    actor: "worker:feeSweep",
    action: "FEE_CREDIT",
    targetType: "FeeEvent",
    targetId: credit.feeEventId,
    meta: { appId: app.id, txHash, wei, ethPriceUsd, split, budgetMicros: credit.budgetMicros },
  });
  try {
    const existing = await prisma.notification.findFirst({ where: { userId: app.launcherId, type: "FEES_CLAIMABLE", readAt: null }, select: { id: true } });
    if (!existing) {
      await prisma.notification.create({ data: { userId: app.launcherId, type: "FEES_CLAIMABLE", title: "You have claimable fees", href: "/me" } });
    }
  } catch (e) {
    log.error({ err: e, appId: app.id }, "failed to create FEES_CLAIMABLE notification");
  }
  return credit;
}

/** Announces a credit on the feed and revives a DORMANT app whose budget is back above the iteration minimum. */
async function announceCredit(ctx: ChainWorkerContext, app: SweepApp, credit: FeeCredit, wei: bigint, txHash: string): Promise<void> {
  await publishEvent(prisma, ctx.redis, app.id, {
    type: "FEES",
    wei: wei.toString(),
    usdMicros: credit.usdMicros.toString(),
    buildMicros: credit.buildMicros.toString(),
    txHash,
    explorerUrl: app.chain === "robinhood" ? explorerTxUrl(txHash) : adapterFor(app.launchpad).info.explorerTxUrl(txHash),
  });
  if (app.status === "DORMANT" && credit.budgetMicros >= BigInt(ITERATION_BUDGET_USD.MIN) * 1_000_000n) {
    await prisma.app.update({ where: { id: app.id }, data: { status: "LIVE" } });
    await publishEvent(prisma, ctx.redis, app.id, { type: "REVIVED", by: "creator fees", budgetUsd: Number(credit.budgetMicros) / 1e6 });
    await audit({
      actor: "worker:feeSweep",
      action: "APP_STATUS",
      targetType: "App",
      targetId: app.id,
      meta: { from: "DORMANT", to: "LIVE", reason: "creator fees credited", budgetMicros: credit.budgetMicros },
    });
    ctx.log.info({ appId: app.id, budgetMicros: credit.budgetMicros.toString() }, "app revived by fees");
  }
  await publishGlobal(ctx.redis, app.id);
}

/**
 * One non-PONS app: creator fees accrue in the launchpad's own vault (no sweep step on pump), the
 * app wallet claims them to itself, the claim is credited with the chain's split, and everything
 * above the wallet's float moves to the treasury on that chain.
 */
export async function sweepVenueApp(ctx: ChainWorkerContext, app: SweepApp, log: Logger): Promise<void> {
  const venue = adapterFor(app.launchpad);
  const wallet = venue.appWallet(app.keypairIndex);
  const token = app.tokenAddress!;
  const state = await venue.readLaunch(token);
  if (!state.exists) {
    log.warn({ token }, "token is not a launch on its venue; skipping");
    return;
  }
  await syncLaunchPhase(ctx, app, state);
  const before = await venue.accruingFees(token, wallet.address);
  if (before.unswept > 0n) {
    const swept = await venue.sweepFees(wallet, token);
    if (swept.swept) log.info({ hash: swept.hash }, "creator fees swept");
  }
  const claimed = await venue.claimFees(wallet, token);
  if (claimed.hash && claimed.amount > 0n) {
    log.info({ amount: claimed.amount.toString(), hash: claimed.hash }, "creator fees claimed into app wallet");
    const credit = await recordCreatorFee(app, claimed.amount, claimed.hash, await venue.nativePriceUsd(), log);
    if (credit) await announceCredit(ctx, app, credit, claimed.amount, claimed.hash);
  }
  const float = VENUE_WALLET_FLOAT[app.chain] ?? 0n;
  const excess = (await venue.nativeBalance(wallet.address)) - float;
  if (excess >= float) {
    const { hash } = await venue.transferNative(wallet, venue.treasury().address, excess);
    log.info({ amount: excess.toString(), hash }, "app wallet swept to treasury");
    await audit({ actor: "worker:feeSweep", action: "FEE_SWEEP", targetType: "App", targetId: app.id, meta: { wei: excess, hash, from: wallet.address, chain: app.chain, keptWei: float, claimedWei: claimed.amount, claimTx: claimed.hash } });
  }
  const after = claimed.amount > 0n ? await venue.accruingFees(token, wallet.address) : before;
  if (after.unswept !== big(app.unsweptWei) || after.claimable !== big(app.escrowWei)) {
    await prisma.app.update({ where: { id: app.id }, data: { unsweptWei: dec(after.unswept), escrowWei: dec(after.claimable) } });
  }
}

/**
 * One app: sweep curve/hook fees into the escrow, claim the escrow into the app wallet, credit the
 * claim, move the ETH to the treasury (keeping the gas reserve) and snapshot what is still accruing.
 * The credit is keyed on the claim tx, so a crash between claim and credit is caught by the
 * reconcile FEES check, which replays `recordCreatorFee` from the escrow's `Claimed` log.
 */
export async function sweepApp(ctx: ChainWorkerContext, app: SweepApp, log: Logger): Promise<void> {
  const wallet = appWallet(app);
  const launch = await readLaunch(app.tokenAddress as Address);
  if (!launch.exists) {
    log.warn({ token: app.tokenAddress }, "token is not a PONS v2 launch; skipping");
    return;
  }
  await syncLaunchPhase(ctx, app, launch);

  const before = await accruingFees(launch);
  if (before.unsweptWei + before.escrowWei > 0n) {
    // Sweeping and claiming are signed by the app wallet; keep it able to pay for them.
    await topUpFromTreasury(wallet, APP_GAS_RESERVE_WEI, APP_GAS_LOW_WEI, log);
    const swept = await sweepCreatorFees(wallet.account, launch);
    if (swept.swept) log.info({ hash: swept.hash, unsweptWei: before.unsweptWei.toString() }, "creator fees swept into escrow");
    else if (swept.reason !== "nothing-to-sweep") log.info({ reason: swept.reason }, "sweep deferred to the PONS operator");
  }

  const claimed = await claimEscrow(wallet.account);
  if (claimed.hash && claimed.wei > 0n) {
    log.info({ wei: claimed.wei.toString(), hash: claimed.hash }, "escrow claimed into app wallet");
    const credit = await recordCreatorFee(app, claimed.wei, claimed.hash, await getEthPriceUsd(), log);
    if (credit) await announceCredit(ctx, app, credit, claimed.wei, claimed.hash);
  }

  // Everything above the gas reserve is platform ETH (claimed fees, leftover launch funding).
  const balance = await getEthBalance(wallet.address);
  const excess = balance - APP_GAS_RESERVE_WEI;
  if (excess >= MIN_MOVE_WEI) {
    const hash = await transferEth(wallet.account, treasury().address, excess);
    log.info({ wei: excess.toString(), hash }, "app wallet swept to treasury");
    await audit({
      actor: "worker:feeSweep",
      action: "FEE_SWEEP",
      targetType: "App",
      targetId: app.id,
      meta: { wei: excess, hash, from: wallet.address, keptWei: APP_GAS_RESERVE_WEI, claimedWei: claimed.wei, claimTx: claimed.hash ?? null },
    });
  }

  const after = claimed.wei > 0n || before.unsweptWei > 0n ? await accruingFees(launch) : before;
  if (after.unsweptWei !== big(app.unsweptWei) || after.escrowWei !== big(app.escrowWei)) {
    await prisma.app.update({ where: { id: app.id }, data: { unsweptWei: dec(after.unsweptWei), escrowWei: dec(after.escrowWei) } });
  }
}

/** Refunds the launch stake from the treasury once the app has reached its first build. */
async function refundStakes(ctx: ChainWorkerContext, log: Logger): Promise<void> {
  const due = await prisma.app.findMany({
    where: { firstBuildAt: { not: null }, stakeRefundedAt: null, stakeWei: { gt: 0 }, status: { in: ["LIVE", "DORMANT"] } },
    include: { launcher: { select: { id: true, wallet: true } } },
  });
  if (due.length === 0) return;
  const t = treasury();
  for (const app of due) {
    const appLog = log.child({ appId: app.id });
    if (!app.launcher.wallet) {
      appLog.warn("launcher has no wallet; stake refund deferred");
      continue;
    }
    const stakeWei = big(app.stakeWei);
    try {
      const balance = await getEthBalance(t.address);
      if (balance - stakeWei < TREASURY_FLOOR_WEI) {
        appLog.warn({ balance: balance.toString(), stakeWei: stakeWei.toString() }, "treasury ETH too low for stake refund");
        continue;
      }
      const hash = await transferEth(t.account, app.launcher.wallet as Address, stakeWei);
      const ethPriceUsd = await getEthPriceUsd();
      await prisma.$transaction([
        prisma.app.update({ where: { id: app.id }, data: { stakeRefundTx: hash, stakeRefundedAt: new Date() } }),
        prisma.ledgerEntry.create({
          data: { account: "TREASURY", deltaMicros: -usdMicrosFromWei(stakeWei, ethPriceUsd), refType: "Payout", refId: app.id, memo: `stake refund ${hash}` },
        }),
      ]);
      await publishEvent(prisma, ctx.redis, app.id, { type: "AGENT_NOTE", text: `Launch stake refunded to launcher: ${explorerTxUrl(hash)}` });
      appLog.info({ hash, wei: stakeWei.toString() }, "stake refunded");
      await audit({
        actor: "worker:feeSweep",
        action: "STAKE_REFUND",
        targetType: "App",
        targetId: app.id,
        meta: { wei: stakeWei, hash, to: app.launcher.wallet, ethPriceUsd },
      });
    } catch (err) {
      appLog.error({ err }, "stake refund failed");
    }
  }
}

/**
 * $PYRE's own creator fees. The treasury launched $PYRE, so it is the creatorFeeRecipient: sweep
 * and claim from the treasury and the ETH simply lands there — platform income, no per-app
 * split. A failure never aborts the pass.
 */
async function sweepPlatformFees(log: Logger): Promise<void> {
  const token = chainWorkerEnv().PYRE_TOKEN;
  if (!token) return;
  try {
    const t = treasury();
    const launch = await readLaunch(token);
    if (!launch.exists) return;
    const swept = await sweepCreatorFees(t.account, launch);
    const claimed = await claimEscrow(t.account);
    if (claimed.wei === 0n) return;
    log.info({ wei: claimed.wei.toString(), hash: claimed.hash, sweepTx: swept.hash ?? null }, "$PYRE creator fees claimed to treasury");
    await audit({
      actor: "worker:feeSweep",
      action: "PLATFORM_FEE_CLAIM",
      targetType: "Treasury",
      targetId: t.address,
      meta: { token, wei: claimed.wei, hash: claimed.hash, sweepTx: swept.hash ?? null },
    });
  } catch (err) {
    log.error({ err }, "$PYRE fee claim failed");
  }
}

/** A whole pass: long enough for every app's RPC round trips, short enough to self-heal after a crash. */
const PASS_LOCK_TTL_SECONDS = 900;
/** One app's sweep + claim + transfer. */
const APP_LOCK_TTL_SECONDS = 300;

/**
 * One fee-sweep pass. Lock-guarded twice: a pass lock so two runner instances cannot
 * double-sweep, and a per-app lock so an explicit sweep cannot race the scheduled pass.
 */
export async function runFeeSweep(ctx: ChainWorkerContext): Promise<void> {
  const log = ctx.log.child({ worker: "feeSweep" });
  const pass = await withLock(
    ctx.redis,
    "lock:feeSweep:pass",
    PASS_LOCK_TTL_SECONDS,
    async () => {
      if (await isPaused("pauseFeeSweep")) {
        log.info("paused via PlatformSetting.pauseFeeSweep");
        return;
      }
      const apps = await prisma.app.findMany({
        where: { tokenAddress: { not: null }, status: { in: ["LIVE", "DORMANT"] } },
        include: SWEEP_APP_INCLUDE,
        orderBy: { keypairIndex: "asc" },
      });
      log.info({ apps: apps.length }, "fee sweep start");
      for (const app of apps) {
        const appPass = await withLock(ctx.redis, `lock:feeSweep:app:${app.id}`, APP_LOCK_TTL_SECONDS, async () => {
          try {
            if (app.chain !== "robinhood") {
              if (solanaEnabled()) await sweepVenueApp(ctx, app, log.child({ appId: app.id, token: app.tokenAddress }));
            } else await sweepApp(ctx, app, log.child({ appId: app.id, token: app.tokenAddress }));
          } catch (err) {
            log.error({ err, appId: app.id }, "fee sweep failed for app");
          }
        });
        if (!appPass.acquired) log.info({ appId: app.id }, "fee sweep skipped for app; lock held");
      }
      await sweepPlatformFees(log);
      await refundStakes(ctx, log);
      log.info("fee sweep done");
    },
    { autoRenew: true },
  );
  if (!pass.acquired) log.info("fee sweep skipped; pass lock held by another runner");
}

export function createFeeSweepWorker(ctx: ChainWorkerContext, connection: ChainWorkerContext["redis"]): Worker {
  return new Worker(CHAIN_QUEUES.feeSweep, () => runFeeSweep(ctx), { connection, concurrency: 1 });
}
