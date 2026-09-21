import { prisma } from "@pyre/db";
import { LOG_CHUNK_BLOCKS, escrowAbi, getEthBalance, getEthPriceUsd, ponsAddresses, publicClient } from "@pyre/chain";
import { getAbiItem, getAddress, type Address } from "viem";
import type { WorkerContext } from "../../lib/queues.js";
import { SWEEP_APP_INCLUDE, recordCreatorFee } from "../chain/feeSweep.js";
import { APP_GAS_RESERVE_WEI } from "../chain/wallet.js";
import { emptyOutcome, type CheckOutcome } from "./report.js";

const CURSOR_KEY = "reconcile:fees:cursor";
/** First run looks back one hour of ~0.1 s blocks. */
const INITIAL_LOOKBACK_BLOCKS = 36_000n;
/** ≤10k-block chunks per pass; the cursor advances only over what was actually scanned. */
const MAX_CHUNKS_PER_PASS = 20n;
/** An app wallet holding this much over its gas reserve for a day without a claim means the sweep is not moving money. */
const IDLE_EXCESS_WEI = 1_000_000_000_000_000n; // 0.001 ETH
const QUIET_WINDOW_MS = 24 * 60 * 60_000;

/**
 * FEES: every `Claimed(recipient, amount)` the fee escrow emitted for an app wallet must have a
 * FeeEvent keyed on its transaction. A missing one is the crash window between claim and credit;
 * it is repaired by replaying `recordCreatorFee` (idempotent on txHash), so the app's budget is
 * never silently short. Also flags app wallets sitting on ETH the sweep should have moved.
 */
export const checkFees = async (ctx: WorkerContext): Promise<CheckOutcome> => {
  const outcome = emptyOutcome();
  const log = ctx.log.child({ worker: "reconcile", check: "FEES" });
  const apps = await prisma.app.findMany({
    where: { tokenAddress: { not: null }, walletAddress: { not: null }, status: { in: ["LIVE", "DORMANT"] } },
    include: SWEEP_APP_INCLUDE,
  });
  outcome.checked = apps.length;
  if (apps.length === 0) return outcome;
  const byWallet: Record<string, (typeof apps)[number]> = {};
  for (const app of apps) byWallet[app.walletAddress!.toLowerCase()] = app;

  const client = publicClient();
  const latest = await client.getBlockNumber();
  const setting = await prisma.platformSetting.findUnique({ where: { key: CURSOR_KEY } });
  const from = typeof setting?.value === "string" ? BigInt(setting.value) + 1n : latest > INITIAL_LOOKBACK_BLOCKS ? latest - INITIAL_LOOKBACK_BLOCKS : 0n;
  const cap = from + LOG_CHUNK_BLOCKS * MAX_CHUNKS_PER_PASS - 1n;
  const to = cap < latest ? cap : latest;

  if (from <= to) {
    const event = getAbiItem({ abi: escrowAbi, name: "Claimed" });
    const { feeEscrow } = ponsAddresses();
    let ethPriceUsd: number | undefined;
    for (let start = from; start <= to; start += LOG_CHUNK_BLOCKS) {
      const end = start + LOG_CHUNK_BLOCKS - 1n < to ? start + LOG_CHUNK_BLOCKS - 1n : to;
      const logs = await client.getLogs({ address: feeEscrow, event, fromBlock: start, toBlock: end, strict: true });
      for (const entry of logs) {
        const app = byWallet[entry.args.recipient.toLowerCase()];
        if (!app || entry.args.amount === 0n) continue;
        outcome.checked++;
        const recorded = await prisma.feeEvent.findUnique({ where: { txHash: entry.transactionHash }, select: { id: true } });
        if (recorded) continue;
        outcome.drifted++;
        ethPriceUsd ??= await getEthPriceUsd();
        const credit = await recordCreatorFee(app, entry.args.amount, entry.transactionHash, ethPriceUsd, log);
        if (credit) outcome.repaired++;
        outcome.findings.push({
          code: "UNRECORDED_ESCROW_CLAIM",
          detail: `escrow Claimed ${entry.args.amount.toString()} wei to ${getAddress(entry.args.recipient)} in ${entry.transactionHash} had no FeeEvent; ${credit ? "recorded" : "already recorded concurrently"}`,
          appId: app.id,
          slug: app.slug,
          txHash: entry.transactionHash,
          wei: entry.args.amount.toString(),
          block: entry.blockNumber.toString(),
        });
        log.warn({ appId: app.id, txHash: entry.transactionHash, wei: entry.args.amount.toString(), repaired: credit !== null }, "escrow claim was not credited");
      }
    }
    await prisma.platformSetting.upsert({ where: { key: CURSOR_KEY }, create: { key: CURSOR_KEY, value: to.toString() }, update: { value: to.toString() } });
  }

  const since = new Date(Date.now() - QUIET_WINDOW_MS);
  const recent = await prisma.feeEvent.groupBy({ by: ["appId"], where: { appId: { in: apps.map((a) => a.id) }, createdAt: { gte: since } }, _count: true });
  const recentByApp: Record<string, number> = {};
  for (const row of recent) recentByApp[row.appId] = row._count;
  for (const app of apps) {
    let balance: bigint;
    try {
      balance = await getEthBalance(app.walletAddress as Address);
    } catch (err) {
      outcome.ok = false;
      outcome.findings.push({
        code: "APP_WALLET_UNREADABLE",
        detail: `eth_getBalance failed for ${app.walletAddress}: ${err instanceof Error ? err.message : String(err)}`,
        appId: app.id,
        slug: app.slug,
      });
      log.warn({ err, appId: app.id }, "app wallet balance unreadable");
      continue;
    }
    if (balance - APP_GAS_RESERVE_WEI < IDLE_EXCESS_WEI || (recentByApp[app.id] ?? 0) > 0) continue;
    outcome.drifted++;
    outcome.findings.push({
      code: "UNSWEPT_APP_WALLET",
      detail: `app wallet holds ${balance.toString()} wei (${(Number(balance) / 1e18).toFixed(5)} ETH) above its gas reserve and no FeeEvent in the last 24h`,
      appId: app.id,
      slug: app.slug,
      walletAddress: app.walletAddress,
      wei: balance.toString(),
    });
    log.warn({ appId: app.id, wei: balance.toString(), walletAddress: app.walletAddress }, "app wallet ETH not swept");
  }
  return outcome;
};
