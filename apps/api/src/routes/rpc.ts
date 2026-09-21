import { Router } from "express";
import { RpcBody } from "@pyre/shared";
import { env } from "../env.js";
import { HttpError, parse, wrap } from "../lib/errors.js";

/**
 * `POST /v1/rpc` — read-only JSON-RPC proxy for the browser. The public Robinhood Chain RPC is
 * rate-limited per origin and production uses a keyed Alchemy URL that must never ship in the web
 * bundle, so the client sends its light reads (balances, receipts, quotes via eth_call) here and the
 * key stays server-side. Only stateless read methods are allowlisted — nothing here can sign or
 * broadcast — and `eth_getLogs` is bounded so one call cannot scan the chain. One request per body
 * (no batches): the rate limiter charges the `rpc` bucket per HTTP request.
 */
const ALLOWED: Record<string, true> = {
  eth_chainId: true,
  eth_blockNumber: true,
  eth_gasPrice: true,
  eth_call: true,
  eth_estimateGas: true,
  eth_getBalance: true,
  eth_getTransactionCount: true,
  eth_getTransactionByHash: true,
  eth_getTransactionReceipt: true,
  eth_getBlockByNumber: true,
  eth_getLogs: true,
};

/** Widest `eth_getLogs` window (blocks ≈ 0.1 s each, so ~3 minutes of chain). */
export const MAX_LOG_RANGE = 2_000n;

const blockTag = (v: unknown): bigint | null => {
  if (typeof v !== "string") return null;
  if (/^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  return null; // "latest"/"earliest"/"pending"/"safe"/"finalized" are resolved below
};

/** Rejects unbounded log scans: both ends must be explicit hex blocks at most MAX_LOG_RANGE apart, or `blockHash` given. */
export const checkLogFilter = (filter: unknown): void => {
  if (filter === null || typeof filter !== "object") throw new HttpError(400, "rpc_bad_params");
  const f = filter as Record<string, unknown>;
  if (typeof f.blockHash === "string") return;
  const from = blockTag(f.fromBlock);
  const to = blockTag(f.toBlock);
  if (from === null || to === null) throw new HttpError(400, "rpc_log_range_required", { maxBlocks: Number(MAX_LOG_RANGE) });
  if (to < from || to - from > MAX_LOG_RANGE) throw new HttpError(400, "rpc_log_range_too_wide", { maxBlocks: Number(MAX_LOG_RANGE) });
};

export const rpc = Router();

rpc.post(
  "/",
  wrap(async (req, res) => {
    if (Array.isArray(req.body)) throw new HttpError(400, "rpc_batch_not_allowed");
    const body = parse(RpcBody, req.body);
    if (!ALLOWED[body.method]) throw new HttpError(403, "rpc_method_not_allowed", { method: body.method });
    if (body.method === "eth_getLogs") checkLogFilter(body.params?.[0]);
    if (body.method === "eth_getBlockByNumber" && body.params?.[1] === true) throw new HttpError(400, "rpc_full_blocks_not_allowed");
    const upstream = await fetch(env.RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: body.id, method: body.method, params: body.params ?? [] }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    res.status(upstream.ok ? 200 : 502).type("application/json").send(text);
  }),
);
