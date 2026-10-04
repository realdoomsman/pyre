#!/usr/bin/env node
/**
 * Builds data/pyre-refund-snapshot.json: every address holding Robinhood Chain PYRE at the refund
 * snapshot block, with the ETH it put into PYRE and took out, up to and including that block.
 *
 *   node apps/runner/scripts/pyre-refund-snapshot.mjs [--rpc <url>] [--cache <file>] [--out <file>]
 *
 * Read-only, no keys, no database. Every number comes from logs on chain:
 * - balance: sum of PYRE `Transfer` logs from the token's first log through the snapshot block
 *   (the public RPC keeps no archive state, so `balanceOf` at the block cannot be read directly).
 * - ETH in / out, attributed to the transaction sender (`tx.from`, the wallet that signed):
 *   PONS curve `CurveBuy.quoteIn` (gross) minus `CurveBuyRefunded.refund`; `CurveSell.quoteOut`
 *   (net of curve fees); Uniswap v4 `Swap` on the PYRE pool, native ETH being currency0, so a buy
 *   is −amount0 and a sell is +amount0. Front-end fees an aggregator skims before the pool are not
 *   ETH that reached PYRE and are not counted.
 * - boughtUnits: PYRE that actually landed in the sender in its buy transactions (net PYRE
 *   Transfer delta of tx.from in each buy tx — after the v4 hook's fee, which event amounts omit).
 * - owedWei = max(0, min(ethIn − ethOut, ethIn × min(balance, boughtUnits) / boughtUnits)):
 *   the ETH still at a loss, capped at the average cost of the PYRE the address still held at
 *   the block. Someone who sold almost everything and kept dust is owed the cost of the dust,
 *   not the loss on what they sold. PYRE that only arrived by transfer was never paid for here
 *   and earns nothing. Only addresses with balance > 0 at the block are listed.
 *
 * Logs and transactions are cached in --cache (default .tmp/pyre-refund-cache.json) so a re-run
 * against the same block does not refetch 20k transactions from a rate-limited RPC.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress } from "viem";

const SNAPSHOT = {
  chainId: 4663,
  token: "0xc8488bE2e4f430420A364E64f4D8af428b74D903",
  block: 79819827,
  blockHash: "0x141e47824b2a808e47e0e4d5262f7c7b3eb0b4f77c6d0b1113b7aa11874df0d8",
  blockTime: "2026-10-04T09:12:28Z",
};
const CURVE = "0x103B89239371e61D42e44971922DdA4DA215286b";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const POOL_ID = "0x46d3902d85b818e03901676f3898177936e08b4c30de4d1c2dd6fea80bb0fe32";
/** Block of PYRE's first Transfer (the launch mint); nothing earlier can touch it. */
const FIRST_BLOCK = 69_395_133;
const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  curveBuy: "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455",
  curveSell: "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df",
  curveRefund: "0xa69e8258ccc7b9bbb70ab953fc2d1062b4ee28b8ca827534097e1732e87b0262",
  swap: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const RPC = arg("--rpc", process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com");
const CACHE = resolve(arg("--cache", ".tmp/pyre-refund-cache.json"));
const OUT = resolve(arg("--out", "data/pyre-refund-snapshot.json"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(body, tries = 0) {
  try {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    const failed = Array.isArray(json) ? json.some((x) => x.error || x.result == null) : json.error;
    if (!failed) return json;
    if (tries >= 20) throw new Error(JSON.stringify(json).slice(0, 400));
    const msg = JSON.stringify(Array.isArray(json) ? json.find((x) => x.error) ?? json[0] : json.error);
    if (!Array.isArray(json) && !/429|rate|Too Many/i.test(msg)) return json; // caller decides (range errors)
  } catch (err) {
    if (tries >= 20) throw err;
  }
  await sleep(2000 * Math.min(tries + 1, 10));
  return rpc(body, tries + 1);
}

const hex = (n) => `0x${n.toString(16)}`;

/** eth_getLogs over [from, to], bisecting on the provider's range, result-count and timeout limits. */
async function logs(filter, from, to, out) {
  if (to - from >= 1_000_000) {
    const mid = Math.floor((from + to) / 2);
    await logs(filter, from, mid, out);
    return logs(filter, mid + 1, to, out);
  }
  const json = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }] });
  if (!json.error) {
    out.push(...json.result);
    return;
  }
  if (from === to || !/exceeds limit|timed out|timeout|spans|narrow/i.test(json.error.message)) throw new Error(`eth_getLogs ${from}-${to}: ${json.error.message}`);
  const mid = Math.floor((from + to) / 2);
  await logs(filter, from, mid, out);
  await logs(filter, mid + 1, to, out);
}

async function fetchRaw() {
  const transfers = [];
  await logs({ address: SNAPSHOT.token, topics: [TOPIC.transfer] }, FIRST_BLOCK, SNAPSHOT.block, transfers);
  const curveLogs = [];
  for (const t of [TOPIC.curveBuy, TOPIC.curveSell, TOPIC.curveRefund]) await logs({ address: CURVE, topics: [t] }, FIRST_BLOCK, SNAPSHOT.block, curveLogs);
  const swapLogs = [];
  await logs({ address: POOL_MANAGER, topics: [TOPIC.swap, POOL_ID] }, FIRST_BLOCK, SNAPSHOT.block, swapLogs);
  return { block: SNAPSHOT.block, transfers, curveLogs, swapLogs, txs: {} };
}

async function fillTxs(raw) {
  const hashes = [...new Set([...raw.curveLogs, ...raw.swapLogs].map((l) => l.transactionHash))].filter((h) => !raw.txs[h]);
  for (let i = 0; i < hashes.length; i += 20) {
    const batch = hashes.slice(i, i + 20);
    const json = await rpc(batch.map((h, id) => ({ jsonrpc: "2.0", id, method: "eth_getTransactionByHash", params: [h] })));
    for (const x of json) raw.txs[x.result.hash] = { from: x.result.from, to: x.result.to, value: x.result.value };
    if (i % 1000 === 0) process.stderr.write(`tx ${i}/${hashes.length}\n`);
    await sleep(250);
  }
}

const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const uint = (data, i) => BigInt(`0x${word(data, i)}`);
const int = (data, i) => {
  const v = uint(data, i);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
};
const topicAddress = (t) => getAddress(`0x${t.slice(26)}`);
const order = (a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16);

function build(raw) {
  const balance = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0n) + v);
  for (const l of [...raw.transfers].sort(order)) {
    if (parseInt(l.blockNumber, 16) > SNAPSHOT.block) continue;
    const v = uint(l.data, 0);
    add(balance, topicAddress(l.topics[1]), -v);
    add(balance, topicAddress(l.topics[2]), v);
  }

  const ethIn = new Map();
  const ethOut = new Map();
  const bought = new Map();
  /** tx hash → net PYRE delta per address within that tx. */
  const txDelta = new Map();
  for (const l of raw.transfers) {
    const d = txDelta.get(l.transactionHash) ?? new Map();
    const v = uint(l.data, 0);
    add(d, topicAddress(l.topics[1]), -v);
    add(d, topicAddress(l.topics[2]), v);
    txDelta.set(l.transactionHash, d);
  }
  const buyTxs = new Set();
  const sender = (l) => {
    const tx = raw.txs[l.transactionHash];
    if (!tx) throw new Error(`missing tx ${l.transactionHash}`);
    return getAddress(tx.from);
  };
  for (const l of raw.curveLogs) {
    if (parseInt(l.blockNumber, 16) > SNAPSHOT.block) continue;
    const who = sender(l);
    if (l.topics[0] === TOPIC.curveBuy) {
      add(ethIn, who, uint(l.data, 0));
      buyTxs.add(l.transactionHash);
    } else if (l.topics[0] === TOPIC.curveSell) add(ethOut, who, uint(l.data, 1));
    else if (l.topics[0] === TOPIC.curveRefund) add(ethIn, who, -uint(l.data, 0));
  }
  for (const l of raw.swapLogs) {
    if (parseInt(l.blockNumber, 16) > SNAPSHOT.block) continue;
    const who = sender(l);
    const amount0 = int(l.data, 0); // native ETH, swapper's view: negative = paid into the pool
    const amount1 = int(l.data, 1); // PYRE, swapper's view: positive = received
    if (amount0 < 0n) add(ethIn, who, -amount0);
    else add(ethOut, who, amount0);
    if (amount1 > 0n) buyTxs.add(l.transactionHash);
  }
  for (const h of buyTxs) {
    const who = getAddress(raw.txs[h].from);
    const got = txDelta.get(h)?.get(who) ?? 0n;
    if (got > 0n) add(bought, who, got);
  }

  const holders = [...balance.entries()]
    .filter(([address, units]) => units > 0n && address !== "0x0000000000000000000000000000000000000000")
    .map(([address, units]) => {
      const i = ethIn.get(address) ?? 0n;
      const o = ethOut.get(address) ?? 0n;
      const b = bought.get(address) ?? 0n;
      const loss = i > o ? i - o : 0n;
      const heldCost = b === 0n ? 0n : (i * (units < b ? units : b)) / b;
      const owed = loss < heldCost ? loss : heldCost;
      return { address, balanceUnits: units.toString(), boughtUnits: b.toString(), ethInWei: i.toString(), ethOutWei: o.toString(), owedWei: owed.toString() };
    })
    .sort((a, b) => (BigInt(b.owedWei) > BigInt(a.owedWei) ? 1 : BigInt(b.owedWei) < BigInt(a.owedWei) ? -1 : a.address.localeCompare(b.address)));

  // The zero address is the mint source and burn sink; its running sum is −(live supply).
  for (const [address, units] of balance) if (units < 0n && address !== "0x0000000000000000000000000000000000000000") throw new Error(`negative balance for ${address}: ${units}`);
  return holders;
}

let raw;
if (existsSync(CACHE)) {
  raw = JSON.parse(readFileSync(CACHE, "utf8"));
  if (raw.block !== SNAPSHOT.block) throw new Error(`cache ${CACHE} is for block ${raw.block}, not ${SNAPSHOT.block}`);
  raw.txs ??= {};
} else {
  raw = await fetchRaw();
}
const hashOk = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [hex(SNAPSHOT.block), false] });
if (hashOk.result?.hash !== SNAPSHOT.blockHash) throw new Error(`block ${SNAPSHOT.block} hash is ${hashOk.result?.hash}, expected ${SNAPSHOT.blockHash}`);
await fillTxs(raw);
mkdirSync(dirname(CACHE), { recursive: true });
writeFileSync(CACHE, JSON.stringify(raw));

const holders = build(raw);
const sum = (k) => holders.reduce((a, h) => a + BigInt(h[k]), 0n);
const out = {
  ...SNAPSHOT,
  method:
    "balance = sum of PYRE Transfer logs through the block; ETH in/out and PYRE bought attributed to tx.from: PONS curve CurveBuy.quoteIn/tokensOut minus CurveBuyRefunded, CurveSell.quoteOut, Uniswap v4 Swap on the PYRE pool (buy = -amount0 ETH / +amount1 PYRE, sell = +amount0); owedWei = max(0, min(in - out, in * min(balance, bought) / bought)); holders with balance > 0 only.",
  generatedAt: new Date().toISOString(),
  holders,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  JSON.stringify({
    out: OUT,
    transfers: raw.transfers.length,
    curveLogs: raw.curveLogs.length,
    swapLogs: raw.swapLogs.length,
    holders: holders.length,
    owedHolders: holders.filter((h) => h.owedWei !== "0").length,
    totalBalanceUnits: sum("balanceUnits").toString(),
    totalOwedWei: sum("owedWei").toString(),
  }),
);
