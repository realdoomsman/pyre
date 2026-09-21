import { getAbiItem, getAddress, type Address, type Hash } from "viem";
import { z } from "zod";
import { publicClient, type PyrePublicClient } from "./chain.js";
import { geckoTerminalUrl } from "./env.js";
import { getEthPriceUsd } from "./price.js";
import { curveAbi, poolManagerAbi } from "./pons/abi.js";
import { ponsAddresses } from "./pons/addresses.js";
import type { LaunchRecord } from "./pons/read.js";

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/** OHLCV in USD; `t` is the bucket start in unix seconds (what lightweight-charts consumes). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Trade {
  hash: Hash;
  block: number;
  /** Unix seconds. */
  ts: number;
  side: "buy" | "sell";
  wallet: Address;
  tokenUnits: bigint;
  /** Quote paid (buy, gross of fees) or received (sell, net of fees). */
  quoteWei: bigint;
  /** Effective price: quoteWei / tokenUnits (both 1e18). */
  priceEth: number;
}

export const INTERVAL_SECONDS: Record<CandleInterval, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };

/** GeckoTerminal `/ohlcv/{timeframe}?aggregate=` mapping. https://apiguide.geckoterminal.com/ */
const GECKO_TIMEFRAME: Record<CandleInterval, { timeframe: "minute" | "hour" | "day"; aggregate: number }> = {
  "1m": { timeframe: "minute", aggregate: 1 },
  "5m": { timeframe: "minute", aggregate: 5 },
  "15m": { timeframe: "minute", aggregate: 15 },
  "1h": { timeframe: "hour", aggregate: 1 },
  "4h": { timeframe: "hour", aggregate: 4 },
  "1d": { timeframe: "day", aggregate: 1 },
};

const GECKO_NETWORK = "robinhood";
const GeckoOhlcv = z.object({ data: z.object({ attributes: z.object({ ohlcv_list: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])) }) }) });

const CACHE_MS = 20_000;
/** Public RPC log queries must stay bounded; Arbitrum Nitro accepts wide ranges but times out on huge ones. */
export const LOG_CHUNK_BLOCKS = 10_000n;
const LOG_CONCURRENCY = 4;
/** ~0.1 s blocks: 100k blocks ≈ 3 hours of history for the on-chain fallback. */
const MAX_FALLBACK_BLOCKS = 100_000n;
const BLOCKS_PER_SECOND = 10;

const cache = new Map<string, { at: number; candles: Candle[] }>();
const inflight = new Map<string, Promise<Candle[]>>();


/** Folds trades into ascending OHLCV candles priced in USD. Pure; used as the GeckoTerminal fallback. */
export function buildCandlesFromTrades(trades: Trade[], interval: CandleInterval, ethPriceUsd: number): Candle[] {
  const size = INTERVAL_SECONDS[interval];
  const sorted = [...trades].sort((a, b) => a.ts - b.ts || a.block - b.block);
  const candles: Candle[] = [];
  let current: Candle | undefined;
  for (const trade of sorted) {
    if (trade.tokenUnits === 0n) continue;
    const t = Math.floor(trade.ts / size) * size;
    const price = trade.priceEth * ethPriceUsd;
    const volume = (Number(trade.quoteWei) / 1e18) * ethPriceUsd;
    if (!current || current.t !== t) {
      current = { t, o: price, h: price, l: price, c: price, v: volume };
      candles.push(current);
      continue;
    }
    current.h = Math.max(current.h, price);
    current.l = Math.min(current.l, price);
    current.c = price;
    current.v += volume;
  }
  return candles;
}

interface BlockMeta {
  ts: number;
  /** tx hash → sender, present only when the block was fetched with transactions. */
  senders?: Record<string, Address>;
}

const blocks = new Map<bigint, BlockMeta>();

/**
 * Block timestamp, plus every transaction sender when `withSenders` (one `eth_getBlockByNumber`
 * serves both, which matters on the rate-limited public RPC). Bounded in-memory cache.
 */
async function blockMeta(block: bigint, withSenders: boolean, client: PyrePublicClient): Promise<BlockMeta> {
  const hit = blocks.get(block);
  if (hit && (!withSenders || hit.senders)) return hit;
  const meta: BlockMeta = { ts: 0 };
  if (withSenders) {
    const full = await client.getBlock({ blockNumber: block, includeTransactions: true });
    meta.ts = Number(full.timestamp);
    meta.senders = {};
    for (const tx of full.transactions) meta.senders[tx.hash] = getAddress(tx.from);
  } else {
    meta.ts = Number((await client.getBlock({ blockNumber: block })).timestamp);
  }
  if (blocks.size > 20_000) blocks.clear();
  blocks.set(block, meta);
  return meta;
}

function chunkRanges(fromBlock: bigint, toBlock: bigint): Array<[bigint, bigint]> {
  const ranges: Array<[bigint, bigint]> = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = start + LOG_CHUNK_BLOCKS - 1n < toBlock ? start + LOG_CHUNK_BLOCKS - 1n : toBlock;
    ranges.push([start, end]);
  }
  return ranges;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Trades from `fromBlock` (inclusive) to `toBlock` (default latest): `CurveBuy`/`CurveSell` on the
 * curve before graduation, PoolManager `Swap` filtered by pool id after. Log queries are chunked
 * to ≤10k blocks. v4 rows resolve the trader from the transaction sender (the event's `sender` is
 * the router).
 */
export async function getTrades(launch: LaunchRecord, fromBlock: bigint, toBlock?: bigint, client: PyrePublicClient = publicClient()): Promise<Trade[]> {
  if (launch.phase === 3) return [];
  const latest = toBlock ?? (await client.getBlockNumber());
  if (fromBlock > latest) return [];
  const ranges = chunkRanges(fromBlock, latest);
  const tokenIs0 = launch.token.toLowerCase() < launch.pairToken.toLowerCase();

  if (launch.phase === 2) {
    const { poolManager } = ponsAddresses();
    const swapEvent = getAbiItem({ abi: poolManagerAbi, name: "Swap" });
    const logs = (
      await mapLimited(ranges, LOG_CONCURRENCY, ([from, to]) =>
        client.getLogs({ address: poolManager, event: swapEvent, args: { id: launch.poolId }, fromBlock: from, toBlock: to, strict: true }),
      )
    ).flat();
    return mapLimited(logs, LOG_CONCURRENCY, async (log): Promise<Trade> => {
      const tokenDelta = tokenIs0 ? log.args.amount0 : log.args.amount1;
      const quoteDelta = tokenIs0 ? log.args.amount1 : log.args.amount0;
      const tokenUnits = tokenDelta < 0n ? -tokenDelta : tokenDelta;
      const quoteWei = quoteDelta < 0n ? -quoteDelta : quoteDelta;
      const meta = await blockMeta(log.blockNumber, true, client);
      return {
        hash: log.transactionHash,
        block: Number(log.blockNumber),
        ts: meta.ts,
        // Deltas are from the swapper's view: a positive token delta means tokens left the pool → buy.
        side: tokenDelta > 0n ? "buy" : "sell",
        wallet: meta.senders?.[log.transactionHash] ?? getAddress(log.args.sender),
        tokenUnits,
        quoteWei,
        priceEth: tokenUnits > 0n ? Number(quoteWei) / Number(tokenUnits) : 0,
      };
    });
  }

  const logs = (
    await mapLimited(ranges, LOG_CONCURRENCY, ([from, to]) =>
      client.getLogs({ address: launch.curve, events: [getAbiItem({ abi: curveAbi, name: "CurveBuy" }), getAbiItem({ abi: curveAbi, name: "CurveSell" })], fromBlock: from, toBlock: to, strict: true }),
    )
  ).flat();
  return mapLimited(logs, LOG_CONCURRENCY, async (log): Promise<Trade> => {
    const { ts } = await blockMeta(log.blockNumber, false, client);
    if (log.eventName === "CurveBuy") {
      const { recipient, quoteIn, tokensOut } = log.args;
      return { hash: log.transactionHash, block: Number(log.blockNumber), ts, side: "buy", wallet: getAddress(recipient), tokenUnits: tokensOut, quoteWei: quoteIn, priceEth: tokensOut > 0n ? Number(quoteIn) / Number(tokensOut) : 0 };
    }
    const { recipient, tokensIn, quoteOut } = log.args;
    return { hash: log.transactionHash, block: Number(log.blockNumber), ts, side: "sell", wallet: getAddress(recipient), tokenUnits: tokensIn, quoteWei: quoteOut, priceEth: tokensIn > 0n ? Number(quoteOut) / Number(tokensIn) : 0 };
  });
}

async function fetchGeckoCandles(poolIdentifier: string, interval: CandleInterval, limit: number): Promise<Candle[]> {
  const { timeframe, aggregate } = GECKO_TIMEFRAME[interval];
  const url = new URL(`${geckoTerminalUrl()}/networks/${GECKO_NETWORK}/pools/${poolIdentifier}/ohlcv/${timeframe}`);
  url.searchParams.set("aggregate", String(aggregate));
  url.searchParams.set("limit", String(Math.min(limit, 1000)));
  url.searchParams.set("currency", "usd");
  const res = await fetch(url, { headers: { accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`geckoterminal ${res.status} ${poolIdentifier}`);
  const rows = GeckoOhlcv.parse(await res.json()).data.attributes.ohlcv_list;
  return rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })).sort((a, b) => a.t - b.t);
}

/**
 * Candles for a launch. GeckoTerminal first (dex `pons-v2`: pool address = curve; `pons-v2-dex`:
 * pool address = 32-byte poolId), trying the identifier for the current phase then the other in
 * case indexing lags a graduation. Falls back to candles built from on-chain trades over the last
 * ≤100k blocks. Cached 20 s per (launch, interval).
 */
export async function getCandles(launch: LaunchRecord, interval: CandleInterval, limit = 300): Promise<Candle[]> {
  const key = `${launch.token}:${interval}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.candles;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const candles = await buildCandles(launch, interval, limit);
        cache.set(key, { at: Date.now(), candles });
        return candles;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
  }
  return pending;
}

async function buildCandles(launch: LaunchRecord, interval: CandleInterval, limit: number): Promise<Candle[]> {
  const identifiers = launch.phase === 2 ? [launch.poolId, launch.curve] : [launch.curve, launch.poolId];
  for (const id of identifiers) {
    try {
      const candles = await fetchGeckoCandles(id, interval, limit);
      if (candles.length > 0) return candles;
    } catch {
      // try the next identifier, then the on-chain fallback
    }
  }
  const client = publicClient();
  const [latest, ethUsd] = await Promise.all([client.getBlockNumber(), getEthPriceUsd()]);
  const wanted = BigInt(limit * INTERVAL_SECONDS[interval] * BLOCKS_PER_SECOND);
  const span = wanted < MAX_FALLBACK_BLOCKS ? wanted : MAX_FALLBACK_BLOCKS;
  const fromBlock = latest > span ? latest - span : 0n;
  const trades = await getTrades(launch, fromBlock, latest, client);
  return buildCandlesFromTrades(trades, interval, ethUsd).slice(-limit);
}
