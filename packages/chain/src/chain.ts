import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type Hash,
  type HttpTransport,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { defineRobinhoodChain, PUBLIC_RPC_URL } from "./browser.js";
import { rpcUrl } from "./env.js";

export { EXPLORER_URL, PUBLIC_RPC_URL, ROBINHOOD_CHAIN_ID, explorerAddressUrl, explorerTxUrl } from "./browser.js";

/**
 * Robinhood Chain (Arbitrum Nitro L2, ~0.1 s blocks, ETH gas), with the RPC pinned to `RPC_URL`.
 * Multicall3 is deployed at the canonical address (bytecode verified live).
 */
export const pyreChain: Chain = defineRobinhoodChain(process.env.RPC_URL || PUBLIC_RPC_URL);

export type PyreChain = typeof pyreChain;
export type PyrePublicClient = PublicClient<HttpTransport, PyreChain>;
export type PyreWalletClient = WalletClient<HttpTransport, PyreChain, LocalAccount>;

/**
 * The public RPC answers a rate-limited batch with a single `{error:{code:429}}` object instead of
 * an array, which the batch scheduler cannot route. Fan such an error out to every request id so
 * each call retries with backoff (viem honours `Retry-After`).
 */
const fetchFn: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.ok || typeof init?.body !== "string" || !init.body.startsWith("[")) return res;
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(text, res);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
    // The body was serialised by viem's batch scheduler: an array of JSON-RPC requests.
    const requests: Array<{ id: number }> = JSON.parse(init.body);
    const fanned = requests.map(({ id }) => ({ jsonrpc: "2.0", id, error: parsed.error }));
    return new Response(JSON.stringify(fanned), { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  return new Response(text, res);
};

const transport = () => http(rpcUrl(), { batch: { batchSize: 50 }, fetchFn, retryCount: 3, retryDelay: 500, timeout: 20_000 });

let singleton: PyrePublicClient | undefined;

/** Process-wide read client: batched JSON-RPC, multicall aggregation, 3 retries. */
export function publicClient(): PyrePublicClient {
  singleton ??= createPublicClient({ chain: pyreChain, transport: transport(), batch: { multicall: true } });
  return singleton;
}

/** Signing client for a local (custodial HD) account. Cheap to create; not cached. */
export function walletClient(account: LocalAccount): PyreWalletClient {
  return createWalletClient({ account, chain: pyreChain, transport: transport() });
}

/** Waits for the receipt and throws if the transaction reverted. */
export async function waitForSuccess(hash: Hash, client: PyrePublicClient = publicClient()): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}
