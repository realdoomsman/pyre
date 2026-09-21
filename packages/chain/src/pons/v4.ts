import { getAddress, maxUint160, maxUint256, parseEventLogs, type Address, type Hash, type Hex, type LocalAccount } from "viem";
import { encodeV4ExactInSingle as encodeWith, swapDirection, type LaunchRecord, type SwapInput } from "../browser.js";
import { publicClient, sendTx, type PyrePublicClient } from "../chain.js";
import { erc20Abi, hookAbi, permit2Abi, poolManagerAbi, universalRouterAbi, v4QuoterAbi } from "./abi.js";
import { ponsAddresses } from "./addresses.js";

export { SETTLE_ALL, SWAP_EXACT_IN_SINGLE, TAKE, TAKE_ALL, V4_SWAP, exactInputSingleParamsAbi, type SwapInput } from "../browser.js";

/**
 * Uniswap v4 swaps for graduated launches, through the Universal Router. Encoding lives in
 * `browser.ts` (shared with in-browser signers); this module adds the quoter, Permit2 and the
 * receipt parsing that needs a client.
 */
export interface SwapResult {
  hash: Hash;
  /** Tokens received (ETH→token) or wei received net of the hook fee (token→ETH). */
  out: bigint;
}

const DEADLINE_SECONDS = 600n;
const PERMIT2_EXPIRY_SECONDS = 30 * 24 * 3600;

/** Quote via `V4Quoter.quoteExactInputSingle` (simulated; the quoter reverts internally to return). */
export async function v4QuoteExactIn(launch: LaunchRecord, input: SwapInput, client: PyrePublicClient = publicClient()): Promise<bigint> {
  const { quoter, memeHook } = ponsAddresses();
  const { key, amountIn, zeroForOne } = swapDirection(launch, input, memeHook);
  const { result } = await client.simulateContract({
    address: quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  });
  return result[0];
}

/** Encodes `execute()` inputs for one exact-in single-hop swap, honouring the env-configured hook. */
export function encodeV4ExactInSingle(launch: LaunchRecord, input: SwapInput, minOut: bigint, sender: Address, recipient: Address): { commands: Hex; inputs: Hex[] } {
  return encodeWith(launch, input, minOut, sender, recipient, ponsAddresses().memeHook);
}

async function ensurePermit2(account: LocalAccount, token: Address, amount: bigint, client: PyrePublicClient): Promise<void> {
  const { permit2, universalRouter } = ponsAddresses();
  const erc20Allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, permit2] });
  if (erc20Allowance < amount) {
    await sendTx(account, (wallet) => wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [permit2, maxUint256] }), client);
  }
  const [allowed, expiration] = await client.readContract({ address: permit2, abi: permit2Abi, functionName: "allowance", args: [account.address, token, universalRouter] });
  const now = Math.floor(Date.now() / 1000);
  if (allowed < amount || expiration <= now + 60) {
    await sendTx(
      account,
      (wallet) =>
        wallet.writeContract({ address: permit2, abi: permit2Abi, functionName: "approve", args: [token, universalRouter, maxUint160, now + PERMIT2_EXPIRY_SECONDS] }),
      client,
    );
  }
}

/**
 * Exact-input swap on the graduated pool. `out` is exact for token output (ERC-20 Transfer logs to
 * the recipient) and, for ETH output, derived from the pool's Swap delta net of the hook fee and
 * creator tax (the hook charges the unspecified currency in `afterSwap`).
 */
export async function v4SwapExactIn(account: LocalAccount, launch: LaunchRecord, input: SwapInput, minOut: bigint, recipient: Address): Promise<SwapResult> {
  const client = publicClient();
  const { universalRouter, memeHook } = ponsAddresses();
  const { amountIn } = swapDirection(launch, input, memeHook);
  if (input.tokensIn !== undefined) await ensurePermit2(account, launch.token, amountIn, client);
  const { commands, inputs } = encodeV4ExactInSingle(launch, input, minOut, account.address, recipient);
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SECONDS;
  const receipt = await sendTx(
    account,
    (wallet) => wallet.writeContract({ address: universalRouter, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline], value: input.ethIn ?? 0n }),
    client,
  );
  const hash = receipt.transactionHash;

  if (input.ethIn !== undefined) {
    const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs, args: { to: getAddress(recipient) } }).filter(
      (log) => log.address.toLowerCase() === launch.token.toLowerCase(),
    );
    return { hash, out: transfers.reduce((sum, log) => sum + log.args.value, 0n) };
  }

  const swap = parseEventLogs({ abi: poolManagerAbi, eventName: "Swap", logs: receipt.logs, args: { id: launch.poolId } })[0];
  if (!swap) throw new Error(`v4 swap ${hash}: no Swap event for pool ${launch.poolId}`);
  const tokenIs0 = launch.token.toLowerCase() < launch.pairToken.toLowerCase();
  const ethDelta = tokenIs0 ? swap.args.amount1 : swap.args.amount0;
  const gross = ethDelta < 0n ? -ethDelta : ethDelta;
  const pool = await client.readContract({ address: memeHook, abi: hookAbi, functionName: "launches", args: [launch.poolId] });
  const hookFeeBps = BigInt(pool[10]);
  const creatorTaxBps = BigInt(pool[7]);
  return { hash, out: gross - (gross * hookFeeBps) / 10_000n - (gross * creatorTaxBps) / 10_000n };
}
