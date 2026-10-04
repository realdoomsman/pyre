import { Worker } from "bullmq";
import type { Logger } from "pino";
import { Prisma, big, dec, prisma } from "@pyre/db";
import { ITERATION_BUDGET_USD, REFUND_FEE_BPS, REFUND_LEDGER_ACCOUNT, VENUES, bps, explorerTxUrl, refundEligibleWei, refundRemainingWei, splitFees, usdMicrosFromNative, usdMicrosFromWei } from "@pyre/shared";
import { SolanaTransactionUnconfirmedError, accruingFees, adapterFor, claimEscrow, claimPyreSolFees, fetchTransaction, getEthBalance, getEthPriceUsd, lamportDelta, pyreSolFeeReceipts, readLaunch, solSigner, solanaEnabled, sweepCreatorFees, transferEth, treasury, type PumpFeeShareholder, type PyreSolFeeClaim, type VenueAccount, type VenueAdapter } from "@pyre/chain";
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
 *
 * The 25% leg (`split.pyreMicros`) of a legacy Robinhood Chain coin funds the PYRE refund program
 * (`REFUND` ledger account) while any snapshot holder is still owed, and falls back to the
 * `PYRE_TOKEN` buy-and-burn once every holder is settled. The decision and the credit sit in the
 * FeeEvent's transaction, so each fee event credits exactly one of the two, exactly once.
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
    // The 25% leg: on Robinhood Chain the PYRE refund pool while a holder is owed, else the PYRE_TOKEN
    // buy-and-burn; the coin's own COINBURN account elsewhere.
    const burnLeg: Prisma.LedgerEntryCreateManyInput =
      app.chain !== "robinhood"
        ? { account: `COINBURN:${app.id}`, deltaMicros: split.coinBurnMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" }
        : split.pyreMicros > 0n && (await refundStillOwed(tx))
          ? { account: REFUND_LEDGER_ACCOUNT, deltaMicros: split.pyreMicros, refType: "FeeEvent", refId: fee.id, memo: "legacy Robinhood Chain coin fee share" }
          : { account: "PYRE_TOKEN", deltaMicros: split.pyreMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" };
    const ledger: Prisma.LedgerEntryCreateManyInput[] = [
      { account: `BUILD:${app.id}`, deltaMicros: split.buildMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" },
      burnLeg,
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
    log.info({ feeEventId: fee.id, wei: wei.toString(), usdMicros: usdMicros.toString(), split, burnLeg: burnLeg.account }, "creator fee recorded");
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

/** `PlatformSetting` key: the Solana PYRE coin's creator-fee route as the last fee sweep saw it; the REFUNDS reconcile check reads it. */
export const REFUND_FEE_ROUTE_KEY = "refund:feeRoute";

export interface PyreSolFeeRoute {
  mint: string;
  treasury: string;
  /** `creator`: the treasury is the coin creator; `shared`: fee sharing, paid to `shareholders`; `foreign`: another wallet is the creator. */
  route: "creator" | "shared" | "foreign";
  /** The coin's creator: the treasury, the sharing-config PDA, or the foreign wallet. */
  creator: string;
  shareholders: PumpFeeShareholder[] | null;
  treasuryShareBps: number;
  checkedAt: string;
}

/** True when none of the coin's creator fees reach the treasury. */
export const feesNotRouted = (r: Pick<PyreSolFeeRoute, "route" | "treasuryShareBps">): boolean => r.route === "foreign" || (r.route === "shared" && r.treasuryShareBps === 0);

/** Persists the route for the reconcile check; audits it whenever it differs from the last one seen. */
async function recordFeeRoute(route: PyreSolFeeRoute): Promise<void> {
  const prev = await prisma.platformSetting.findUnique({ where: { key: REFUND_FEE_ROUTE_KEY } });
  const last = prev?.value as Partial<PyreSolFeeRoute> | undefined;
  const value = route as unknown as Prisma.InputJsonValue;
  await prisma.platformSetting.upsert({ where: { key: REFUND_FEE_ROUTE_KEY }, create: { key: REFUND_FEE_ROUTE_KEY, value }, update: { value } });
  const same =
    last?.mint === route.mint && last.route === route.route && last.creator === route.creator && last.treasuryShareBps === route.treasuryShareBps && JSON.stringify(last.shareholders ?? null) === JSON.stringify(route.shareholders);
  if (same) return;
  await audit({ actor: "worker:feeSweep", action: "PLATFORM_FEE_ROUTE", targetType: "Treasury", targetId: route.treasury, meta: { chain: "solana", ...route, previous: last ?? null } });
}

/** `PlatformSetting` key: how far the treasury's history has been scanned for fee-sharing distributions of the Solana PYRE coin. */
export const REFUND_DISTRIBUTION_CURSOR_KEY = "refund:distributionCursor";
/** Signature pages (100 each) the receipts scan reads per pass; a longer backlog continues on the next pass. */
const RECEIPT_PAGES_PER_PASS = 5;

/**
 * `signature`: newest treasury signature below which every distribution has been credited (null:
 * from the start of history). `catchUp`: a scan that stopped early (page cap or a failed credit)
 * — everything from `head` down to `before` (exclusive) is done, and the next pass resumes below
 * `before`; once it reaches `signature`, `head` becomes the new `signature`.
 */
export interface RefundDistributionCursor {
  mint: string;
  treasury: string;
  signature: string | null;
  catchUp: { head: string; before: string } | null;
  updatedAt: string;
}

/**
 * The Solana PYRE coin's creator fees. The coin may be created by the treasury Solana wallet
 * (route `creator`: it claims them to itself) or by the founder's wallet with pump.fun fee
 * sharing paying the treasury (route `shared`). While any snapshot holder is still owed,
 * REFUND_FEE_BPS of what the treasury actually received (USD at credit time) is credited to the
 * REFUND ledger account and the rest stays in the treasury, idempotent per transaction signature.
 * `creator`: the claim is the receipt, credited under its signature (one broadcast but left
 * unconfirmed is kept and credited on a later pass once it lands). `shared`: distribution is
 * permissionless, so the treasury sends one itself when fees are pending (keeps them moving), but
 * credits only from `creditDistributionReceipts`, which finds every distribution that paid the
 * treasury — its own or anyone else's. When the fees reach someone else (route `foreign`, or a
 * sharing config without the treasury) nothing is credited, a warning is logged and the REFUNDS
 * reconcile check reports REFUND_FEES_NOT_ROUTED. A failure never aborts the pass.
 */
export async function sweepPyreSolFees(log: Logger): Promise<void> {
  const mint = chainWorkerEnv().PYRE_SOL_MINT;
  if (!mint || !solanaEnabled()) return;
  const venue = adapterFor("pump_fun");
  let t: VenueAccount;
  try {
    t = venue.treasury();
  } catch (err) {
    log.error({ err }, "Solana PYRE fee claim failed");
    return;
  }
  try {
    await resolvePendingCreatorClaims(venue, t, mint, log);
  } catch (err) {
    log.error({ err }, "Solana PYRE pending creator fee claims could not be resolved; retried next pass");
  }
  let claimed: PyreSolFeeClaim | null = null;
  try {
    claimed = await claimPyreSolFees(solSigner(t), mint);
    const route: PyreSolFeeRoute = {
      mint,
      treasury: t.address,
      route: claimed.route,
      creator: claimed.creator,
      shareholders: claimed.route === "shared" ? claimed.shareholders : null,
      treasuryShareBps: claimed.route === "creator" ? 10_000 : claimed.route === "shared" ? claimed.treasuryShareBps : 0,
      checkedAt: new Date().toISOString(),
    };
    await recordFeeRoute(route);
    if (feesNotRouted(route)) {
      log.warn({ mint, route: route.route, creator: route.creator, shareholders: route.shareholders, treasury: t.address }, "Solana PYRE creator fees do not reach the treasury; nothing claimed or credited to REFUND");
    }
    if (claimed.hash && claimed.amount > 0n) await recordPyreSolClaim(venue, route, claimed.amount, claimed.hash, log);
  } catch (err) {
    log.error({ err }, "Solana PYRE fee claim failed");
    if (err instanceof SolanaTransactionUnconfirmedError) {
      try {
        await rememberPendingCreatorClaim(err.signature, mint, t.address, log);
      } catch (saveErr) {
        log.error({ err: saveErr, signature: err.signature }, "Solana PYRE unconfirmed creator fee claim could not be saved for resolution");
      }
    }
  }
  // Only a sharing config can pay the treasury in someone else's transaction; when the route is unknown (claim failed) scan anyway.
  if (claimed?.route === "creator" || claimed?.route === "foreign") return;
  try {
    await creditDistributionReceipts(venue, mint, t.address, log);
  } catch (err) {
    log.error({ err }, "Solana PYRE distribution receipts scan failed");
  }
}

/**
 * Logs, credits and audits one claim that paid the treasury `lamports` under `hash`, at the SOL
 * price of now. Only route `creator` credits here (the claim is the receipt): a distribution is
 * credited by the receipts scan, like anyone else's; crediting it here too is harmless (same
 * refId) but would split the audit trail.
 */
async function recordPyreSolClaim(
  venue: VenueAdapter,
  route: Pick<PyreSolFeeRoute, "mint" | "treasury" | "route" | "creator" | "treasuryShareBps">,
  lamports: bigint,
  hash: string,
  log: Logger,
  landedLate = false,
): Promise<void> {
  const solPriceUsd = await venue.nativePriceUsd();
  const usdMicros = usdMicrosFromNative(lamports, solPriceUsd, VENUES.pump_fun.native.decimals);
  log.info(
    { lamports: lamports.toString(), hash, usdMicros: usdMicros.toString(), route: route.route, treasuryShareBps: route.treasuryShareBps },
    landedLate ? "Solana PYRE creator fee claim landed after an unconfirmed broadcast" : "Solana PYRE creator fees claimed to treasury",
  );
  const refundMicros = route.route === "creator" ? await creditRefundShare(usdMicros, lamports, hash, log) : null;
  await audit({
    actor: "worker:feeSweep",
    action: "PLATFORM_FEE_CLAIM",
    targetType: "Treasury",
    targetId: route.treasury,
    meta: { chain: "solana", mint: route.mint, route: route.route, creator: route.creator, treasuryShareBps: route.treasuryShareBps, lamports, hash, solPriceUsd, usdMicros, refundMicros, ...(landedLate ? { unconfirmedBroadcast: true } : {}) },
  });
}

/** `PlatformSetting` key: creator-route claims broadcast but never confirmed, oldest first; each pass resolves them before claiming again. */
export const REFUND_PENDING_CREATOR_CLAIMS_KEY = "refund:pendingCreatorClaims";
/** Unresolved claims kept; past this the oldest is dropped, logged — a claim still unknown after that many passes all but certainly never landed. */
const MAX_PENDING_CREATOR_CLAIMS = 20;

export interface PendingCreatorClaim {
  signature: string;
  broadcastAt: string;
}

async function pendingCreatorClaims(): Promise<PendingCreatorClaim[]> {
  const row = await prisma.platformSetting.findUnique({ where: { key: REFUND_PENDING_CREATOR_CLAIMS_KEY } });
  return Array.isArray(row?.value) ? (row.value as unknown as PendingCreatorClaim[]) : [];
}

async function savePendingCreatorClaims(claims: PendingCreatorClaim[]): Promise<void> {
  const value = claims as unknown as Prisma.InputJsonValue;
  await prisma.platformSetting.upsert({ where: { key: REFUND_PENDING_CREATOR_CLAIMS_KEY }, create: { key: REFUND_PENDING_CREATOR_CLAIMS_KEY, value }, update: { value } });
}

/**
 * A claim broadcast whose status could not be read may still land and move the fees to the
 * treasury: keep its signature so the next pass credits it. Skipped when the last route seen was
 * `shared`: that signature is a distribution, which the receipts scan credits once it lands.
 */
async function rememberPendingCreatorClaim(signature: string, mint: string, treasuryAddress: string, log: Logger): Promise<void> {
  const row = await prisma.platformSetting.findUnique({ where: { key: REFUND_FEE_ROUTE_KEY } });
  const last = row?.value as Partial<PyreSolFeeRoute> | undefined;
  if (last?.mint === mint && last.treasury === treasuryAddress && last.route === "shared") return;
  const claims = await pendingCreatorClaims();
  if (claims.some((c) => c.signature === signature)) return;
  claims.push({ signature, broadcastAt: new Date().toISOString() });
  const dropped = claims.splice(0, Math.max(0, claims.length - MAX_PENDING_CREATOR_CLAIMS));
  await savePendingCreatorClaims(claims);
  log.warn({ signature }, "Solana PYRE creator fee claim broadcast but unconfirmed; resolved next pass");
  if (dropped.length > 0) log.error({ dropped }, "Solana PYRE pending creator fee claims over the cap; oldest dropped without resolution");
}

/**
 * Settles every pending creator claim: landed → credited exactly like a confirmed claim (by the
 * treasury's lamport gain, under its signature, so re-resolving never credits twice); failed on
 * chain → dropped; still not found → kept for the next pass.
 */
async function resolvePendingCreatorClaims(venue: VenueAdapter, t: VenueAccount, mint: string, log: Logger): Promise<void> {
  const claims = await pendingCreatorClaims();
  if (claims.length === 0) return;
  const treasuryKey = solSigner(t).publicKey;
  const route = { mint, treasury: t.address, route: "creator", creator: t.address, treasuryShareBps: 10_000 } as const;
  const keep: PendingCreatorClaim[] = [];
  for (const claim of claims) {
    try {
      const tx = await fetchTransaction(claim.signature);
      if (!tx.meta) throw new Error(`solana transaction ${claim.signature} has no status meta`);
      if (tx.meta.err) {
        log.info({ signature: claim.signature, err: tx.meta.err }, "Solana PYRE unconfirmed creator fee claim failed on chain; nothing to credit");
        continue;
      }
      const gained = lamportDelta(tx, treasuryKey);
      if (gained > 0n) await recordPyreSolClaim(venue, route, gained, claim.signature, log, true);
      else log.info({ signature: claim.signature, lamports: gained.toString() }, "Solana PYRE unconfirmed creator fee claim landed without paying the treasury; nothing to credit");
    } catch (err) {
      keep.push(claim);
      if (err instanceof SolanaTransactionUnconfirmedError) log.warn({ signature: claim.signature, broadcastAt: claim.broadcastAt }, "Solana PYRE creator fee claim still unconfirmed; retried next pass");
      else log.error({ err, signature: claim.signature }, "Solana PYRE pending creator fee claim could not be resolved; retried next pass");
    }
  }
  await savePendingCreatorClaims(keep);
}

/**
 * Credits the refund share of every fee-sharing distribution that paid the treasury since the
 * cursor, whoever sent it, newest first. A receipt is done once credited (or found already
 * credited, or owed to no one); the first failure stops the pass and the cursor keeps everything
 * from that receipt down for the next one, so nothing is skipped and nothing is credited twice.
 */
async function creditDistributionReceipts(venue: VenueAdapter, mint: string, treasuryAddress: string, log: Logger): Promise<void> {
  const row = await prisma.platformSetting.findUnique({ where: { key: REFUND_DISTRIBUTION_CURSOR_KEY } });
  const saved = row?.value as RefundDistributionCursor | undefined;
  const cur = saved?.mint === mint && saved.treasury === treasuryAddress ? saved : undefined;
  const done = cur?.signature ?? null;
  const catchUp = cur?.catchUp ?? null;
  const scan = await pyreSolFeeReceipts(mint, treasuryAddress, done ?? undefined, { before: catchUp?.before, maxPages: RECEIPT_PAGES_PER_PASS });
  const head = catchUp?.head ?? scan.head;
  if (!head) return;

  let solPriceUsd: number | undefined;
  let lastDone: string | undefined;
  let failed = false;
  for (const r of scan.receipts) {
    if (r.treasuryLamports > 0n) {
      try {
        solPriceUsd ??= await venue.nativePriceUsd();
        const usdMicros = usdMicrosFromNative(r.treasuryLamports, solPriceUsd, VENUES.pump_fun.native.decimals);
        const refundMicros = await creditRefundShare(usdMicros, r.treasuryLamports, r.signature, log);
        if (refundMicros > 0n) {
          log.info({ signature: r.signature, lamports: r.treasuryLamports.toString(), usdMicros: usdMicros.toString(), refundMicros: refundMicros.toString() }, "Solana PYRE fee distribution credited to REFUND");
          await audit({
            actor: "worker:feeSweep",
            action: "PLATFORM_FEE_DISTRIBUTION",
            targetType: "Treasury",
            targetId: treasuryAddress,
            meta: { chain: "solana", mint, signature: r.signature, slot: r.slot, blockTime: r.blockTime, lamports: r.treasuryLamports, eventLamports: r.eventLamports, balanceLamports: r.balanceLamports, solPriceUsd, usdMicros, refundMicros },
          });
        }
      } catch (err) {
        log.error({ err, signature: r.signature }, "Solana PYRE fee distribution credit failed; retried next pass");
        failed = true;
        break;
      }
    }
    lastDone = r.signature;
  }

  let next: Pick<RefundDistributionCursor, "signature" | "catchUp">;
  if (failed) {
    const before = lastDone ?? catchUp?.before;
    next = { signature: done, catchUp: before ? { head, before } : null };
  } else if (scan.reachedUntil) {
    next = { signature: head, catchUp: null };
  } else {
    next = { signature: done, catchUp: { head, before: scan.oldest ?? head } };
  }
  const value = { mint, treasury: treasuryAddress, ...next, updatedAt: new Date().toISOString() } satisfies RefundDistributionCursor as unknown as Prisma.InputJsonValue;
  await prisma.platformSetting.upsert({ where: { key: REFUND_DISTRIBUTION_CURSOR_KEY }, create: { key: REFUND_DISTRIBUTION_CURSOR_KEY, value }, update: { value } });
}

/**
 * True while any snapshot holder still has eligible wei left to settle. Holders who sold or moved
 * their snapshot PYRE stay below owedWei forever, so "still owed" is eligible − settled, not
 * owed − settled. `db` is the caller's transaction when the answer decides a write in it.
 */
export async function refundStillOwed(db: Pick<Prisma.TransactionClient, "refundHolder"> = prisma): Promise<boolean> {
  const unsettled = await db.refundHolder.findMany({
    where: { settledWei: { lt: prisma.refundHolder.fields.owedWei }, minBalanceUnits: { gt: 0 } },
    select: { owedWei: true, settledWei: true, balanceUnits: true, minBalanceUnits: true },
  });
  return unsettled.some((h) => refundRemainingWei(refundEligibleWei(big(h.owedWei), big(h.balanceUnits), big(h.minBalanceUnits)), big(h.settledWei)) > 0n);
}

/**
 * Credits the refund share of one claim that paid the treasury `lamports` worth `usdMicros`; 0n when
 * no holder has eligible wei left to settle or the claim was already credited. The RefundFeeCredit
 * row (primary key = signature) and the REFUND LedgerEntry are written in one transaction, so a
 * concurrent credit of the same signature fails on the key (P2002) and leaves no ledger entry behind.
 */
async function creditRefundShare(usdMicros: bigint, lamports: bigint, signature: string, log: Logger): Promise<bigint> {
  const share = bps(usdMicros, REFUND_FEE_BPS);
  if (share <= 0n) return 0n;
  if (!(await refundStillOwed())) return 0n;
  if (await prisma.refundFeeCredit.findUnique({ where: { signature }, select: { signature: true } })) return 0n;
  try {
    await prisma.$transaction([
      prisma.refundFeeCredit.create({ data: { signature, lamports: dec(lamports), usdMicros: share } }),
      prisma.ledgerEntry.create({ data: { account: REFUND_LEDGER_ACCOUNT, deltaMicros: share, refType: "PlatformFee", refId: signature, memo: "Solana PYRE creator fee share" } }),
    ]);
  } catch (err) {
    // A concurrent credit of the same signature won the RefundFeeCredit insert; ours rolled back whole.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      log.info({ signature }, "Solana PYRE fee share already credited to REFUND");
      return 0n;
    }
    throw err;
  }
  return share;
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
      await sweepPyreSolFees(log);
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
