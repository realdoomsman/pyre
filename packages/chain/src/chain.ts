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
import { withSendLock } from "./sendLock.js";

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

/** The transaction was mined and reverted: nothing it was meant to move has moved. */
export class TransactionRevertedError extends Error {
  constructor(readonly hash: Hash) {
    super(`transaction ${hash} reverted`);
    this.name = "TransactionRevertedError";
  }
}

/**
 * The transaction was broadcast but its receipt could not be read (timeout, replacement, RPC
 * error). It may still mine: a caller that moved funds MUST NOT treat this as "never sent".
 */
export class TransactionUnconfirmedError extends Error {
  constructor(
    readonly hash: Hash,
    override readonly cause: unknown,
  ) {
    super(`transaction ${hash} broadcast but unconfirmed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "TransactionUnconfirmedError";
  }
}

/** Waits for the receipt; throws `TransactionRevertedError` on revert, `TransactionUnconfirmedError` when the receipt cannot be read. */
export async function waitForSuccess(hash: Hash, client: PyrePublicClient = publicClient()): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
  } catch (err) {
    throw new TransactionUnconfirmedError(hash, err);
  }
  if (receipt.status !== "success") throw new TransactionRevertedError(hash);
  return receipt;
}

/**
 * Every state-changing transaction goes through here: `send` broadcasts from the account's wallet
 * client, then the receipt is awaited — all under the sender's cross-process lock so two services
 * signing the same key cannot race a nonce. Resolves with the successful receipt.
 */
export function sendTx(account: LocalAccount, send: (wallet: PyreWalletClient) => Promise<Hash>, client: PyrePublicClient = publicClient()): Promise<TransactionReceipt> {
  return withSendLock(account.address, async () => waitForSuccess(await send(walletClient(account)), client));
}
