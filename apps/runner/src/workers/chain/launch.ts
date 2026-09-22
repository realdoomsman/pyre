import { Worker, type Job } from "bullmq";
import type { Logger } from "pino";
import { big, prisma, type Prisma } from "@pyre/db";
import { AppSpec, VENUES, explorerTxUrl, ponsUrl, usdMicrosFromNative, usdMicrosFromWei } from "@pyre/shared";
import {
  LOG_CHUNK_BLOCKS,
  LaunchGatedError,
  adapterFor,
  factoryAbi,
  getEthBalance,
  getEthPriceUsd,
  launchPonsToken,
  ponsAddresses,
  predictLaunchCost,
  publicClient,
  readLaunch,
  transferEth,
  treasury,
  type LaunchParams,
  type DerivedWallet,
  type VenueAdapter,
} from "@pyre/chain";
import { getAbiItem, getAddress, keccak256, stringToBytes, type Address, type Hash } from "viem";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { withLock } from "../../lib/lock.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { chainWorkerEnv } from "./env.js";
import { publishEvent, publishGlobal } from "./publish.js";
import { APP_GAS_LOW_WEI, APP_GAS_RESERVE_WEI, TREASURY_FLOOR_WEI, appWallet, topUpFromTreasury } from "./wallet.js";

const LaunchJob = z.object({ appId: z.string().min(1) });

type LaunchApp = Prisma.AppGetPayload<{ include: { launcher: { select: { id: true; wallet: true; solWallet: true } } } }>;

/** Pre-fund headroom over the simulated launch cost (gas price can move between the estimate and the send). */
const FUNDING_MARGIN_NUM = 13n;
const FUNDING_MARGIN_DEN = 10n;
/** How far back a crashed launch is searched for when the app wallet has already sent a transaction (~5.5 h). */
const ADOPT_SCAN_BLOCKS = 200_000n;

/**
 * Every retry of the same app launches with the same CREATE2 salt, so a second `launchToken`
 * after a crash-then-retry reverts on the factory instead of minting a second coin.
 */
const launchSalt = (appId: string) => keccak256(stringToBytes(`pyre:launch:${appId}`));

function launchParams(app: LaunchApp, wallet: DerivedWallet): LaunchParams {
  const env = chainWorkerEnv();
  const spec = AppSpec.safeParse(app.spec);
  const website = env.APP_DOMAIN ? `https://${app.slug}.${env.APP_DOMAIN}` : `${env.API_ORIGIN}/a/${app.slug}`;
  return {
    name: app.name,
    symbol: app.ticker,
    logo: app.imageUrl,
    description: (spec.success ? spec.data.oneLiner : app.prompt).slice(0, 2048),
    socials: { website, ...(app.twitterUrl ? { twitter: app.twitterUrl } : {}) },
    creatorFeeRecipient: wallet.address,
    salt: launchSalt(app.id),
  };
}

/**
 * The factory's `TokenLaunched` for this app wallet, if a prior attempt broadcast one. Each app
 * wallet launches exactly one coin, so any hit is ours. Bounded to `fromBlock`..latest in
 * ≤10k-block chunks.
 */
async function findPriorLaunch(deployer: Address, fromBlock: bigint): Promise<{ token: Address; curve: Address; hash: Hash; block: bigint } | null> {
  const client = publicClient();
  const latest = await client.getBlockNumber();
  const event = getAbiItem({ abi: factoryAbi, name: "TokenLaunched" });
  for (let from = fromBlock; from <= latest; from += LOG_CHUNK_BLOCKS) {
    const to = from + LOG_CHUNK_BLOCKS - 1n < latest ? from + LOG_CHUNK_BLOCKS - 1n : latest;
    const logs = await client.getLogs({ address: ponsAddresses().factory, event, args: { deployer }, fromBlock: from, toBlock: to, strict: true });
    const hit = logs[0];
    if (hit) return { token: getAddress(hit.args.token), curve: getAddress(hit.args.curve), hash: hit.transactionHash, block: hit.blockNumber };
  }
  return null;
}

async function finishLive(ctx: ChainWorkerContext, app: LaunchApp, found: { token: Address; curve: Address; hash: Hash; block: bigint }, note: string, log: Logger): Promise<void> {
  const [launch, block] = await Promise.all([readLaunch(found.token), publicClient().getBlock({ blockNumber: found.block })]);
  await prisma.app.update({
    where: { id: app.id },
    data: {
      tokenAddress: found.token,
      curveAddress: found.curve,
      poolId: launch.poolId,
      launchTx: found.hash,
      launchBlock: found.block,
      lastIndexedBlock: found.block,
      launchPhase: launch.phase,
      launchedAt: app.launchedAt ?? new Date(Number(block.timestamp) * 1000),
      status: "LIVE",
      lastPriceAt: null,
    },
  });
  log.info({ token: found.token, curve: found.curve, hash: found.hash }, note);
  await audit({
    actor: "worker:launch",
    action: "APP_LAUNCH",
    targetType: "App",
    targetId: app.id,
    meta: { token: found.token, curve: found.curve, hash: found.hash, block: found.block, stakeWei: big(app.stakeWei), launcherId: app.launcherId, note },
  });
  await publishEvent(prisma, ctx.redis, app.id, {
    type: "LAUNCH",
    tokenAddress: found.token,
    curveAddress: found.curve,
    launchpadUrl: ponsUrl(found.token),
    explorerUrl: explorerTxUrl(found.hash),
    txHash: found.hash,
  });
  await publishGlobal(ctx.redis, app.id);
}

async function markGated(ctx: ChainWorkerContext, app: LaunchApp, wallet: DerivedWallet, log: Logger): Promise<void> {
  await prisma.app.update({ where: { id: app.id }, data: { status: "LAUNCH_GATED" } });
  await audit({
    actor: "worker:launch",
    action: "APP_STATUS",
    targetType: "App",
    targetId: app.id,
    meta: { from: app.status, to: "LAUNCH_GATED", wallet: wallet.address, reason: "PONS canLaunch() returned false" },
  });
  await publishEvent(prisma, ctx.redis, app.id, { type: "LAUNCH_GATED", wallet: wallet.address });
  const existing = await prisma.notification.findFirst({ where: { userId: app.launcherId, type: "LAUNCH_GATED", readAt: null }, select: { id: true } });
  if (!existing) {
    await prisma.notification.create({
      data: {
        userId: app.launcherId,
        type: "LAUNCH_GATED",
        title: "Launch is gated on PONS right now",
        body: "PONS is not accepting public launches from new wallets at the moment. Your stake is safe; the launch retries automatically.",
        href: `/c/${app.slug}`,
      },
    });
  }
  await publishGlobal(ctx.redis, app.id);
  log.warn({ wallet: wallet.address }, "launch gated by PONS");
}

/**
 * Failed launch: return whatever the app wallet holds (pre-funding, and the stake when it was
 * paid there) to the treasury, then refund the stake from the treasury to the launcher's wallet.
 * Each leg is best-effort and audited; a leg that cannot run leaves the money where it is for an
 * operator, never in limbo between two accounts.
 */
async function refundFailedLaunch(ctx: ChainWorkerContext, app: LaunchApp, wallet: DerivedWallet, log: Logger): Promise<void> {
  const t = treasury();
  try {
    const balance = await getEthBalance(wallet.address);
    const wei = balance - APP_GAS_LOW_WEI;
    if (wei > 0n) {
      const hash = await transferEth(wallet.account, t.address, wei);
      log.info({ wei: wei.toString(), hash }, "app wallet drained back to treasury");
      await audit({ actor: "worker:launch", action: "APP_WALLET_DRAIN", targetType: "App", targetId: app.id, meta: { wei, hash, from: wallet.address } });
    }
  } catch (err) {
    log.error({ err }, "draining app wallet failed; funds stay in the app wallet");
  }
  const stakeWei = big(app.stakeWei);
  if (stakeWei <= 0n || app.stakeRefundedAt) return;
  if (!app.launcher.wallet) {
    log.warn("launcher has no wallet; stake refund deferred");
    return;
  }
  try {
    const treasuryWei = await getEthBalance(t.address);
    if (treasuryWei - stakeWei < TREASURY_FLOOR_WEI) throw new Error(`treasury holds ${treasuryWei} wei; refunding ${stakeWei} would breach the floor`);
    const hash = await transferEth(t.account, app.launcher.wallet as Address, stakeWei);
    const ethPriceUsd = await getEthPriceUsd();
    await prisma.$transaction([
      prisma.app.update({ where: { id: app.id }, data: { stakeRefundTx: hash, stakeRefundedAt: new Date() } }),
      prisma.ledgerEntry.create({
        data: { account: "TREASURY", deltaMicros: -usdMicrosFromWei(stakeWei, ethPriceUsd), refType: "Payout", refId: app.id, memo: `stake refund ${hash}` },
      }),
    ]);
    await publishEvent(prisma, ctx.redis, app.id, { type: "AGENT_NOTE", text: `Stake refunded: ${explorerTxUrl(hash)}` });
    await audit({ actor: "worker:launch", action: "STAKE_REFUND", targetType: "App", targetId: app.id, meta: { wei: stakeWei, hash, to: app.launcher.wallet, ethPriceUsd } });
    log.info({ hash, wei: stakeWei.toString() }, "stake refunded");
  } catch (err) {
    log.error({ err }, "stake refund failed; will need manual refund");
  }
}

/* ─────────────────────────── Non-PONS venues (pump.fun) ─────────────────────────── */

/** Native float left in a Solana app wallet after the launch: rent exemption plus fees for the claim/sweep passes (≈0.02 SOL). */
const VENUE_WALLET_FLOAT: Record<string, bigint> = { solana: 20_000_000n };
/** The treasury Solana wallet never funds below this (a coin burn + a launch must stay possible). */
const VENUE_TREASURY_FLOOR: Record<string, bigint> = { solana: 100_000_000n };

async function finishLiveVenue(ctx: ChainWorkerContext, app: LaunchApp, venue: VenueAdapter, found: { token: string; curve: string; hash: string; block: number }, note: string, log: Logger): Promise<void> {
  const state = await venue.readLaunch(found.token);
  await prisma.app.update({
    where: { id: app.id },
    data: {
      tokenAddress: found.token,
      curveAddress: found.curve,
      poolId: state.pool,
      launchTx: found.hash,
      launchBlock: BigInt(found.block),
      lastIndexedBlock: BigInt(found.block),
      launchPhase: state.phase,
      launchedAt: app.launchedAt ?? new Date(),
      status: "LIVE",
      lastPriceAt: null,
    },
  });
  log.info({ token: found.token, curve: found.curve, hash: found.hash }, note);
  await audit({
    actor: "worker:launch",
    action: "APP_LAUNCH",
    targetType: "App",
    targetId: app.id,
    meta: { token: found.token, curve: found.curve, hash: found.hash, block: found.block, chain: app.chain, launchpad: app.launchpad, stakeWei: big(app.stakeWei), launcherId: app.launcherId, note },
  });
  await publishEvent(prisma, ctx.redis, app.id, {
    type: "LAUNCH",
    tokenAddress: found.token,
    curveAddress: found.curve,
    launchpadUrl: venue.info.launchpadUrl(found.token),
    explorerUrl: venue.info.explorerTxUrl(found.hash),
    txHash: found.hash,
  });
  await publishGlobal(ctx.redis, app.id);
}

/** Failed venue launch: drain the app wallet back to the treasury on that chain, then refund the stake to the launcher's wallet there. */
async function refundFailedVenueLaunch(ctx: ChainWorkerContext, app: LaunchApp, venue: VenueAdapter, log: Logger): Promise<void> {
  const wallet = venue.appWallet(app.keypairIndex);
  const t = venue.treasury();
  const float = VENUE_WALLET_FLOAT[app.chain] ?? 0n;
  try {
    const wei = (await venue.nativeBalance(wallet.address)) - float / 10n;
    if (wei > 0n) {
      const { hash } = await venue.transferNative(wallet, t.address, wei);
      log.info({ wei: wei.toString(), hash }, "app wallet drained back to treasury");
      await audit({ actor: "worker:launch", action: "APP_WALLET_DRAIN", targetType: "App", targetId: app.id, meta: { wei, hash, from: wallet.address, chain: app.chain } });
    }
  } catch (err) {
    log.error({ err }, "draining app wallet failed; funds stay in the app wallet");
  }
  const stakeWei = big(app.stakeWei);
  if (stakeWei <= 0n || app.stakeRefundedAt) return;
  const to = app.launcher.solWallet ?? venue.userWallet((await prisma.user.findUniqueOrThrow({ where: { id: app.launcherId }, select: { walletIndex: true } })).walletIndex).address;
  try {
    const treasuryWei = await venue.nativeBalance(t.address);
    if (treasuryWei - stakeWei < (VENUE_TREASURY_FLOOR[app.chain] ?? 0n)) throw new Error(`treasury holds ${treasuryWei}; refunding ${stakeWei} would breach the floor`);
    const { hash } = await venue.transferNative(t, to, stakeWei);
    const nativePriceUsd = await venue.nativePriceUsd();
    await prisma.$transaction([
      prisma.app.update({ where: { id: app.id }, data: { stakeRefundTx: hash, stakeRefundedAt: new Date() } }),
      prisma.ledgerEntry.create({
        data: { account: "TREASURY", deltaMicros: -usdMicrosFromNative(stakeWei, nativePriceUsd, venue.info.native.decimals), refType: "Payout", refId: app.id, memo: `stake refund ${hash}` },
      }),
    ]);
    await publishEvent(prisma, ctx.redis, app.id, { type: "AGENT_NOTE", text: `Stake refunded: ${venue.info.explorerTxUrl(hash)}` });
    await audit({ actor: "worker:launch", action: "STAKE_REFUND", targetType: "App", targetId: app.id, meta: { wei: stakeWei, hash, to, chain: app.chain, nativePriceUsd } });
    log.info({ hash, wei: stakeWei.toString() }, "stake refunded");
  } catch (err) {
    log.error({ err }, "stake refund failed; will need manual refund");
  }
}

/**
 * Launch on a non-PONS venue through its adapter: check the launchpad accepts launches, pre-fund
 * the app wallet from the treasury on that chain with the predicted cost plus a float, create the
 * coin (the app wallet signs and is the creator, so creator fees accrue to it), record the mint,
 * curve and slot. The metadata JSON pump reads is served by the API (`/v1/apps/:slug/metadata.json`).
 */
async function launchVenueApp(ctx: ChainWorkerContext, app: LaunchApp, log: Logger): Promise<void> {
  const venue = adapterFor(app.launchpad);
  const wallet = venue.appWallet(app.keypairIndex);
  if (app.tokenAddress && app.launchTx) {
    await finishLiveVenue(ctx, app, venue, { token: app.tokenAddress, curve: app.curveAddress ?? "", hash: app.launchTx, block: Number(app.launchBlock ?? 0n) }, "token already recorded; marked LIVE", log);
    return;
  }
  const env = chainWorkerEnv();
  const spec = AppSpec.safeParse(app.spec);
  const website = env.APP_DOMAIN ? `https://${app.slug}.${env.APP_DOMAIN}` : `${env.API_ORIGIN}/a/${app.slug}`;
  const params = {
    name: app.name,
    symbol: app.ticker,
    imageUrl: app.imageUrl,
    metadataUrl: `${env.API_ORIGIN}/v1/apps/${app.slug}/metadata.json`,
    description: (spec.success ? spec.data.oneLiner : app.prompt).slice(0, 2048),
    socials: { website, ...(app.twitterUrl ? { twitter: app.twitterUrl } : {}) },
  };
  try {
    const gate = await venue.canLaunch(wallet.address);
    if (!gate.ok) {
      await prisma.app.update({ where: { id: app.id }, data: { status: "LAUNCH_GATED" } });
      await audit({ actor: "worker:launch", action: "APP_STATUS", targetType: "App", targetId: app.id, meta: { from: app.status, to: "LAUNCH_GATED", wallet: wallet.address, reason: gate.reason ?? `${VENUES[app.launchpad].launchpadLabel} is not accepting launches` } });
      await publishEvent(prisma, ctx.redis, app.id, { type: "LAUNCH_GATED", wallet: wallet.address });
      return;
    }
    const cost = await venue.predictLaunchCost(wallet.address);
    const need = (cost * FUNDING_MARGIN_NUM) / FUNDING_MARGIN_DEN + (VENUE_WALLET_FLOAT[app.chain] ?? 0n);
    const have = await venue.nativeBalance(wallet.address);
    if (have < need) {
      const t = venue.treasury();
      const top = need - have;
      const treasuryWei = await venue.nativeBalance(t.address);
      if (treasuryWei - top < (VENUE_TREASURY_FLOOR[app.chain] ?? 0n)) throw new Error(`treasury on ${app.chain} holds ${treasuryWei}; funding ${top} would breach the floor`);
      const { hash } = await venue.transferNative(t, wallet.address, top);
      await audit({ actor: "worker:launch", action: "APP_WALLET_FUND", targetType: "App", targetId: app.id, meta: { wei: top, hash, need, launchCost: cost, chain: app.chain } });
    }
    await prisma.app.update({ where: { id: app.id }, data: { launchBlock: BigInt(await venue.currentBlock()) } });
    const result = await venue.launch(wallet, params);
    await finishLiveVenue(ctx, app, venue, result, `coin launched on ${VENUES[app.launchpad].launchpadLabel}`, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "launch failed");
    await prisma.app.update({ where: { id: app.id }, data: { status: "FAILED", killedReason: `launch failed: ${message}`.slice(0, 500) } });
    await audit({ actor: "worker:launch", action: "APP_STATUS", targetType: "App", targetId: app.id, meta: { from: app.status, to: "FAILED", reason: `launch failed: ${message}`.slice(0, 500) } });
    await publishEvent(prisma, ctx.redis, app.id, { type: "AGENT_NOTE", text: `Launch failed: ${message}. Stake is being refunded.` });
    await refundFailedVenueLaunch(ctx, app, venue, log);
    await publishGlobal(ctx.redis, app.id);
  }
}

async function launchApp(ctx: ChainWorkerContext, appId: string, jobId: string): Promise<void> {
  const log = ctx.log.child({ worker: "launch", appId, jobId });
  const app = await prisma.app.findUnique({ where: { id: appId }, include: { launcher: { select: { id: true, wallet: true, solWallet: true } } } });
  if (!app) {
    log.warn("app not found");
    return;
  }
  if (app.status !== "LAUNCHING" && app.status !== "LAUNCH_GATED") {
    log.info({ status: app.status }, "app not launchable; skipping");
    return;
  }
  if (app.chain !== "robinhood") {
    await launchVenueApp(ctx, app, log);
    return;
  }
  const wallet = appWallet(app);
  if (app.tokenAddress && app.launchTx) {
    // A previous attempt wrote the token but died before flipping status.
    const receipt = await publicClient().getTransactionReceipt({ hash: app.launchTx as Hash });
    await finishLive(ctx, app, { token: app.tokenAddress as Address, curve: app.curveAddress as Address, hash: app.launchTx as Hash, block: receipt.blockNumber }, "token already recorded; marked LIVE", log);
    return;
  }
  const client = publicClient();
  // A fresh app wallet has never sent a transaction; a nonce means an earlier attempt broadcast the
  // launch. Adopt that coin instead of launching a second one.
  if ((await client.getTransactionCount({ address: wallet.address })) > 0) {
    const latest = await client.getBlockNumber();
    const from = app.launchBlock ?? (latest > ADOPT_SCAN_BLOCKS ? latest - ADOPT_SCAN_BLOCKS : 0n);
    const prior = await findPriorLaunch(wallet.address, from);
    if (prior) {
      await finishLive(ctx, app, prior, "prior launch found on-chain; adopted", log);
      return;
    }
    log.warn({ wallet: wallet.address }, "app wallet has a nonce but no TokenLaunched was found; launching");
  }
  const params = launchParams(app, wallet);
  try {
    const cost = await predictLaunchCost(wallet.address, params);
    const need = (cost.totalWei * FUNDING_MARGIN_NUM) / FUNDING_MARGIN_DEN;
    const funded = await topUpFromTreasury(wallet, need + APP_GAS_RESERVE_WEI, need, log);
    if (funded.hash) {
      await audit({ actor: "worker:launch", action: "APP_WALLET_FUND", targetType: "App", targetId: app.id, meta: { wei: funded.wei, hash: funded.hash, need, launchFeeWei: cost.launchFeeWei } });
    }
    // Anchor the adoption scan before broadcasting so a crash between send and record is recoverable.
    const anchor = await client.getBlockNumber();
    await prisma.app.update({ where: { id: app.id }, data: { launchBlock: anchor } });
    const result = await launchPonsToken(wallet.account, params);
    const receipt = await client.getTransactionReceipt({ hash: result.hash });
    await finishLive(ctx, app, { token: result.token, curve: result.curve, hash: result.hash, block: receipt.blockNumber }, "coin launched on PONS v2", log);
  } catch (err) {
    if (err instanceof LaunchGatedError) {
      await markGated(ctx, app, wallet, log);
      return;
    }
    // The launch tx can land even when the call throws (broadcast then timeout). Adopt it rather
    // than failing the app and refunding a stake that already bought a coin.
    const prior = app.launchBlock !== null || (await client.getTransactionCount({ address: wallet.address })) > 0
      ? await findPriorLaunch(wallet.address, app.launchBlock ?? (await client.getBlockNumber()) - ADOPT_SCAN_BLOCKS).catch(() => null)
      : null;
    if (prior) {
      await finishLive(ctx, app, prior, "launch call errored but the coin landed on-chain; adopted", log);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "launch failed");
    await prisma.app.update({ where: { id: app.id }, data: { status: "FAILED", killedReason: `launch failed: ${message}`.slice(0, 500) } });
    await audit({
      actor: "worker:launch",
      action: "APP_STATUS",
      targetType: "App",
      targetId: app.id,
      meta: { from: app.status, to: "FAILED", reason: `launch failed: ${message}`.slice(0, 500) },
    });
    await publishEvent(prisma, ctx.redis, app.id, { type: "AGENT_NOTE", text: `Launch failed: ${message}. Stake is being refunded.` });
    await refundFailedLaunch(ctx, app, wallet, log);
    await publishGlobal(ctx.redis, app.id);
  }
}

/** A launch is a handful of RPC round trips plus one mined transaction; well inside this. */
const LAUNCH_LOCK_TTL_SECONDS = 300;
/** Job name of the repeatable sweep that re-attempts LAUNCH_GATED apps (PONS gate may reopen any time). */
export const RETRY_GATED_JOB = "retryGated";

async function launchLocked(ctx: ChainWorkerContext, appId: string, jobId: string): Promise<void> {
  // Per app: a retry of the same launch must never race the original and launch twice.
  const held = await withLock(ctx.redis, `lock:launch:${appId}`, LAUNCH_LOCK_TTL_SECONDS, () => launchApp(ctx, appId, jobId));
  if (!held.acquired) ctx.log.info({ worker: "launch", appId }, "launch already in progress; skipping");
}

export function createLaunchWorker(ctx: ChainWorkerContext, connection: ChainWorkerContext["redis"]): Worker {
  return new Worker(
    CHAIN_QUEUES.launch,
    async (job: Job) => {
      if (job.name === RETRY_GATED_JOB) {
        const gated = await prisma.app.findMany({ where: { status: "LAUNCH_GATED" }, select: { id: true }, orderBy: { updatedAt: "asc" } });
        for (const app of gated) await launchLocked(ctx, app.id, job.id ?? "");
        return;
      }
      const data = LaunchJob.parse(job.data);
      await launchLocked(ctx, data.appId, job.id ?? "");
    },
    { connection, concurrency: 2 },
  );
}
