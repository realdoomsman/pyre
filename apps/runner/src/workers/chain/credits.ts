import { dec, prisma } from "@pyre/db";
import { MIN_CREDITS_FUNDING_USD, weiFromUsdMicros } from "@pyre/shared";
import {
  computePoolId,
  erc20Abi,
  getEthBalance,
  getEthPriceUsd,
  poolKey,
  ponsAddresses,
  publicClient,
  stateViewAbi,
  transferErc20,
  transferEth,
  treasury,
  universalRouterAbi,
  usdgAddress,
  v4QuoterAbi,
  sendTx,
  type LaunchRecord,
  type PoolKey,
} from "@pyre/chain";
import { encodeV4ExactInSingle } from "@pyre/chain/browser";
import type { Logger } from "pino";
import { getAddress, parseEventLogs, zeroAddress, type Address, type Hash } from "viem";
import { audit } from "../../lib/audit.js";
import { chainWorkerEnv } from "./env.js";
import { TREASURY_FLOOR_WEI } from "./wallet.js";

/*
 * Model-credit funding. Each coin's `CREDITS:<appId>` ledger balance is its accrued, unfunded
 * share of creator fees earmarked for the card that pays Anthropic. When CREDITS_FUNDING_WALLET
 * is set, every coin whose balance clears MIN_CREDITS_FUNDING_USD is funded from the treasury:
 *
 *   1. ETH → USDG through a hookless Uniswap v4 ETH/USDG pool on Robinhood Chain, when one
 *      exists (the standard fee tiers are probed for liquidity via StateView, cached an hour),
 *      then the USDG is transferred to the funding wallet; or
 *   2. when no such pool exists, the ETH itself is transferred to the funding wallet and the
 *      row records `usdgUnits = 0`, so the deposit is visibly ETH-denominated.
 *
 * One `CreditFunding` row per deposit, scoped to the coin, plus a negative `CREDITS:<appId>`
 * ledger entry that clears the funded amount. With the wallet unset, credits simply keep
 * accruing in the ledger.
 */

/** Uniswap v4 standard fee tiers; tick spacing per the v4 deployment defaults. */
const FEE_TIERS: Array<{ fee: number; tickSpacing: number }> = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10_000, tickSpacing: 200 },
];
const POOL_CACHE_MS = 60 * 60_000;
const SLIPPAGE_BPS = 100n;
const DEADLINE_SECONDS = 600n;

let poolCache: { at: number; pool: LaunchRecord | null } | undefined;

/** Deepest hookless ETH/USDG v4 pool across the standard fee tiers, or null when none has liquidity. */
export async function findUsdgPool(): Promise<LaunchRecord | null> {
  if (poolCache && Date.now() - poolCache.at < POOL_CACHE_MS) return poolCache.pool;
  const client = publicClient();
  const { stateView } = ponsAddresses();
  const usdg = usdgAddress();
  let best: { launch: LaunchRecord; liquidity: bigint } | null = null;
  for (const tier of FEE_TIERS) {
    const key: PoolKey = poolKey(usdg, zeroAddress, tier.fee, tier.tickSpacing, zeroAddress);
    const poolId = computePoolId(key);
    const liquidity = await client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] }).catch(() => 0n);
    if (liquidity > 0n && (!best || liquidity > best.liquidity)) {
      best = {
        liquidity,
        launch: {
          token: usdg,
          curve: zeroAddress,
          deployer: zeroAddress,
          creatorFeeRecipient: zeroAddress,
          pairToken: zeroAddress,
          phase: 2,
          graduationThresholdWei: 0n,
          poolFee: tier.fee,
          tickSpacing: tier.tickSpacing,
          poolId,
          buybackEnabled: false,
          creatorTaxBps: 0,
          exists: true,
        },
      };
    }
  }
  poolCache = { at: Date.now(), pool: best?.launch ?? null };
  return poolCache.pool;
}

/** ETH → USDG on the hookless pool from the treasury, 1% slippage; returns the USDG received. */
async function swapEthForUsdg(pool: LaunchRecord, wei: bigint): Promise<{ hash: Hash; usdgUnits: bigint }> {
  const client = publicClient();
  const { quoter, universalRouter } = ponsAddresses();
  const t = treasury();
  const key = poolKey(pool.token, pool.pairToken, pool.poolFee, pool.tickSpacing, zeroAddress);
  const { result } = await client.simulateContract({
    address: quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: key, zeroForOne: true, exactAmount: wei, hookData: "0x" }],
  });
  const minOut = (result[0] * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const { commands, inputs } = encodeV4ExactInSingle(pool, { ethIn: wei }, minOut, t.address, t.address, zeroAddress);
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SECONDS;
  const receipt = await sendTx(
    t.account,
    (wallet) => wallet.writeContract({ address: universalRouter, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline], value: wei }),
    client,
  );
  const hash = receipt.transactionHash;
  const usdgUnits = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs, args: { to: t.address } })
    .filter((log) => log.address.toLowerCase() === pool.token.toLowerCase())
    .reduce((sum, log) => sum + log.args.value, 0n);
  if (usdgUnits === 0n) throw new Error(`swap ${hash}: no USDG received`);
  return { hash, usdgUnits };
}

export async function fundCredits(log: Logger): Promise<void> {
  const wallet = chainWorkerEnv().CREDITS_FUNDING_WALLET;
  if (!wallet) return;
  const minMicros = BigInt(MIN_CREDITS_FUNDING_USD) * 1_000_000n;
  const balances = await prisma.ledgerEntry.groupBy({ by: ["account"], where: { account: { startsWith: "CREDITS:" } }, _sum: { deltaMicros: true } });
  const due = balances
    .map((b) => ({ appId: b.account.slice("CREDITS:".length), pending: b._sum.deltaMicros ?? 0n }))
    .filter((x) => x.pending >= minMicros);
  if (due.length === 0) return;

  const t = treasury();
  const destination: Address = getAddress(wallet);
  const [ethPriceUsd, pool] = await Promise.all([getEthPriceUsd(), findUsdgPool()]);
  if (!pool) log.info("no ETH/USDG v4 pool with liquidity; credits are funded in ETH");
  for (const { appId, pending } of due) {
    // A coin with an in-flight funding (PENDING/SWAPPED) from a crashed pass has not had its credits
    // cleared yet; funding again would double-deposit. Skip it — the stuck row surfaces as an ops alert.
    const inflight = await prisma.creditFunding.findFirst({ where: { appId, status: { in: ["PENDING", "SWAPPED"] } }, select: { id: true, status: true } });
    if (inflight) {
      log.warn({ appId, fundingId: inflight.id, status: inflight.status }, "credit funding in-flight from a prior pass; skipping to avoid double-deposit");
      continue;
    }
    const wei = weiFromUsdMicros(pending, ethPriceUsd);
    const treasuryWei = await getEthBalance(t.address);
    if (treasuryWei - wei < TREASURY_FLOOR_WEI) {
      log.warn({ appId, pending: pending.toString(), wei: wei.toString(), treasuryWei: treasuryWei.toString() }, "treasury ETH too low to fund credits; stopping this pass");
      return;
    }
    const funding = await prisma.creditFunding.create({ data: { appId, usdMicros: pending, ethWei: dec(wei), wallet: destination, status: "PENDING" } });
    let swapTx: Hash | null = null;
    try {
      let usdgUnits = 0n;
      let transferTx: Hash;
      if (pool) {
        const swap = await swapEthForUsdg(pool, wei);
        swapTx = swap.hash;
        usdgUnits = swap.usdgUnits;
        await prisma.creditFunding.update({ where: { id: funding.id }, data: { status: "SWAPPED", swapTx, usdgUnits } });
        transferTx = await transferErc20(t.account, pool.token, destination, usdgUnits);
      } else {
        transferTx = await transferEth(t.account, destination, wei);
      }
      await prisma.$transaction([
        prisma.creditFunding.update({ where: { id: funding.id }, data: { status: "SENT", transferTx, usdgUnits, completedAt: new Date() } }),
        prisma.ledgerEntry.create({ data: { account: `CREDITS:${appId}`, deltaMicros: -pending, refType: "CreditFunding", refId: funding.id, memo: "credit deposit" } }),
      ]);
      log.info({ appId, fundingId: funding.id, usdMicros: pending.toString(), wei: wei.toString(), usdgUnits: usdgUnits.toString(), swapTx, transferTx }, "coin credits funded");
      await audit({
        actor: "worker:feeSweep",
        action: "CREDIT_FUNDING",
        targetType: "CreditFunding",
        targetId: funding.id,
        meta: { appId, usdMicros: pending, ethWei: wei, usdgUnits, swapTx, transferTx, to: destination, via: pool ? "usdg" : "eth" },
      });
    } catch (err) {
      // A landed swap leaves USDG in the treasury: keep the row SWAPPED (the in-flight guard then
      // holds this coin for an operator) instead of FAILED, which would swap the same ETH again.
      const error = err instanceof Error ? err.message.slice(0, 500) : String(err);
      await prisma.creditFunding.update({ where: { id: funding.id }, data: { ...(swapTx ? {} : { status: "FAILED" }), error } });
      log.error({ err, appId, fundingId: funding.id, swapTx }, swapTx ? "credit transfer failed after swap; row left SWAPPED for manual reconcile" : "coin credit funding failed; balance left for next pass");
    }
  }
}
