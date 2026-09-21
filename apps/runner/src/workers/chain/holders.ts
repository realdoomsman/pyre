import { Worker } from "bullmq";
import { big, dec, prisma, type Prisma } from "@pyre/db";
import { DEAD_ADDRESS, LOG_CHUNK_BLOCKS, getHolders, ponsAddresses, publicClient, readLaunch, tokenAbi } from "@pyre/chain";
import type { Logger } from "pino";
import { getAbiItem, getAddress, zeroAddress, type Address } from "viem";
import { withLock } from "../../lib/lock.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { chainWorkerEnv } from "./env.js";
import { publishGlobal } from "./publish.js";

const INSERT_BATCH = 1000;
/** A 300k-block backfill can touch thousands of wallets; Prisma's 5 s default transaction budget would wedge the cursor forever. */
const HOLDER_TX = { timeout: 120_000, maxWait: 10_000 } as const;
/** A full holder snapshot per app is the slowest chain pass; the schedule is 10 minutes. */
const PASS_LOCK_TTL_SECONDS = 900;
/** Blockscout rows fetched per app. */
const HOLDER_LIMIT = 1000;
/** Transfer-log indexing: at most this many 10k-block chunks per app per pass (≈8 h of chain time), so a backfill converges over a few passes. */
const MAX_CHUNKS_PER_PASS = 30n;

type HolderApp = Prisma.AppGetPayload<{ select: { id: true; tokenAddress: true; holdersCount: true; launchBlock: true } }>;

/** Protocol-owned balances (curve, locker, vault, pool manager, burn sink) never count as holders. */
function systemAddresses(curve: Address): Record<string, true> {
  const { locker, poolManager, buybackVault } = ponsAddresses();
  const table: Record<string, true> = {};
  for (const a of [DEAD_ADDRESS, locker, poolManager, buybackVault, curve]) table[a.toLowerCase()] = true;
  return table;
}

/**
 * Explorer path: replace the snapshot with Blockscout's holder list. An empty result is not proof
 * that a coin has no holders (an unindexed token or a rate-limited call also returns nothing), and
 * `HolderBalance` is the electorate for governance and the holder-tier gate — so a populated
 * snapshot is never replaced by an empty one.
 */
async function refreshFromBlockscout(ctx: ChainWorkerContext, app: HolderApp, log: Logger): Promise<void> {
  const holders = await getHolders(app.tokenAddress as Address, HOLDER_LIMIT);
  if (holders.length === 0 && app.holdersCount > 0) {
    log.warn({ appId: app.id, token: app.tokenAddress, knownHolders: app.holdersCount }, "explorer returned no holders for an app that has them; keeping the previous snapshot");
    return;
  }
  const holdersCount = holders.filter((h) => h.system === null).length;
  await prisma.$transaction(async (tx) => {
    await tx.holderBalance.deleteMany({ where: { appId: app.id } });
    for (let i = 0; i < holders.length; i += INSERT_BATCH) {
      await tx.holderBalance.createMany({ data: holders.slice(i, i + INSERT_BATCH).map((h) => ({ appId: app.id, wallet: h.address, amount: dec(h.units) })) });
    }
    await tx.app.update({ where: { id: app.id }, data: { holdersCount } });
  });
  if (holdersCount !== app.holdersCount) await publishGlobal(ctx.redis, app.id);
  log.info({ appId: app.id, rows: holders.length, holders: holdersCount }, "holders refreshed from explorer");
}

const cursorKey = (appId: string) => `holdersCursor:${appId}`;

/**
 * Self-indexed path: fold the token's `Transfer` logs since the last cursor (or the launch block)
 * into the stored balances. Bounded per pass; the cursor and the balance deltas commit together
 * so a crash mid-pass replays nothing and skips nothing. Changed wallets are rewritten in bulk
 * (delete + createMany batches) rather than one upsert round trip each, so a first backfill with
 * real trading fits the transaction budget instead of timing out on every pass.
 */
async function refreshFromLogs(ctx: ChainWorkerContext, app: HolderApp, log: Logger): Promise<void> {
  if (app.launchBlock === null) {
    log.warn({ appId: app.id }, "no launch block recorded; cannot index holders from logs");
    return;
  }
  const client = publicClient();
  const token = getAddress(app.tokenAddress as Address);
  const setting = await prisma.platformSetting.findUnique({ where: { key: cursorKey(app.id) } });
  const cursor = typeof setting?.value === "string" ? BigInt(setting.value) : null;
  const latest = await client.getBlockNumber();
  const from = cursor === null ? app.launchBlock : cursor + 1n;
  if (from > latest) return;
  const cap = from + LOG_CHUNK_BLOCKS * MAX_CHUNKS_PER_PASS - 1n;
  const to = cap < latest ? cap : latest;

  const balances = new Map<string, bigint>();
  if (cursor !== null) {
    for (const row of await prisma.holderBalance.findMany({ where: { appId: app.id }, select: { wallet: true, amount: true } })) balances.set(row.wallet, big(row.amount));
  }
  const changed = new Set<string>();
  const event = getAbiItem({ abi: tokenAbi, name: "Transfer" });
  for (let start = from; start <= to; start += LOG_CHUNK_BLOCKS) {
    const end = start + LOG_CHUNK_BLOCKS - 1n < to ? start + LOG_CHUNK_BLOCKS - 1n : to;
    const logs = await client.getLogs({ address: token, event, fromBlock: start, toBlock: end, strict: true });
    for (const entry of logs) {
      const { from: sender, to: recipient, value } = entry.args;
      if (sender !== zeroAddress) {
        const w = getAddress(sender);
        balances.set(w, (balances.get(w) ?? 0n) - value);
        changed.add(w);
      }
      if (recipient !== zeroAddress) {
        const w = getAddress(recipient);
        balances.set(w, (balances.get(w) ?? 0n) + value);
        changed.add(w);
      }
    }
  }

  const launch = await readLaunch(token, client);
  const system = systemAddresses(launch.curve);
  let holdersCount = 0;
  for (const [wallet, amount] of balances) if (amount > 0n && !system[wallet.toLowerCase()]) holdersCount++;

  const changedWallets = [...changed];
  const holders: Prisma.HolderBalanceCreateManyInput[] = [];
  for (const wallet of changedWallets) {
    const amount = balances.get(wallet) ?? 0n;
    if (amount > 0n) holders.push({ appId: app.id, wallet, amount: dec(amount) });
  }
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < changedWallets.length; i += INSERT_BATCH) {
      await tx.holderBalance.deleteMany({ where: { appId: app.id, wallet: { in: changedWallets.slice(i, i + INSERT_BATCH) } } });
    }
    for (let i = 0; i < holders.length; i += INSERT_BATCH) {
      await tx.holderBalance.createMany({ data: holders.slice(i, i + INSERT_BATCH) });
    }
    await tx.app.update({ where: { id: app.id }, data: { holdersCount } });
    await tx.platformSetting.upsert({ where: { key: cursorKey(app.id) }, create: { key: cursorKey(app.id), value: to.toString() }, update: { value: to.toString() } });
  }, HOLDER_TX);
  if (holdersCount !== app.holdersCount) await publishGlobal(ctx.redis, app.id);
  log.info({ appId: app.id, from: from.toString(), to: to.toString(), changed: changed.size, holders: holdersCount, caughtUp: to === latest }, "holders indexed from transfer logs");
}

export async function runHolderRefresh(ctx: ChainWorkerContext): Promise<void> {
  const log = ctx.log.child({ worker: "holders" });
  const pass = await withLock(ctx.redis, "lock:holders:pass", PASS_LOCK_TTL_SECONDS, async () => {
    const explorer = chainWorkerEnv().BLOCKSCOUT_API_KEY !== undefined;
    const apps = await prisma.app.findMany({
      where: { tokenAddress: { not: null }, status: { in: ["LIVE", "DORMANT"] } },
      select: { id: true, tokenAddress: true, holdersCount: true, launchBlock: true },
    });
    for (const app of apps) {
      try {
        if (explorer) await refreshFromBlockscout(ctx, app, log);
        else await refreshFromLogs(ctx, app, log);
      } catch (err) {
        log.warn({ err, appId: app.id, token: app.tokenAddress }, "holder refresh failed for app");
      }
    }
  });
  if (!pass.acquired) log.info("holder refresh skipped; pass lock held by another runner");
}

export function createHoldersWorker(ctx: ChainWorkerContext, connection: ChainWorkerContext["redis"]): Worker {
  return new Worker(CHAIN_QUEUES.holders, () => runHolderRefresh(ctx), { connection, concurrency: 1 });
}
