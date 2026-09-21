import { getAddress, parseEventLogs, type Address, type Hash, type LocalAccount } from "viem";
import { quoteBuy, quoteSell, readCurveState as readCurveStateWith, type BuyQuote, type CurveState } from "../browser.js";
import { publicClient, sendTx, type PyrePublicClient } from "../chain.js";
import { curveAbi, tokenAbi } from "./abi.js";

export { BPS, effectiveSnipeTaxBps, quoteBuy, quoteSell, withSlippage, type BuyQuote, type CurveState } from "../browser.js";

/** Reads everything a quote needs in one multicall round trip. */
export async function readCurveState(curve: Address, recipient: Address, client: PyrePublicClient = publicClient()): Promise<CurveState> {
  return readCurveStateWith(curve, recipient, client);
}

export async function curveQuoteBuy(curve: Address, wei: bigint, recipient: Address, client: PyrePublicClient = publicClient()): Promise<BuyQuote> {
  return quoteBuy(await readCurveState(curve, recipient, client), wei);
}

export async function curveQuoteSell(curve: Address, tokens: bigint, client: PyrePublicClient = publicClient()): Promise<bigint> {
  const c = { address: curve, abi: curveAbi } as const;
  const [reserves, feeBps, creatorTaxBps] = await Promise.all([
    client.readContract({ ...c, functionName: "getReserves" }),
    client.readContract({ ...c, functionName: "feeBps" }),
    client.readContract({ ...c, functionName: "creatorTaxBps" }),
  ]);
  return quoteSell({ quoteReserve: reserves[0], tokenReserve: reserves[1], feeBps, creatorTaxBps }, tokens);
}

export interface CurveBuyResult {
  hash: Hash;
  tokensOut: bigint;
  /** Quote returned by a clamped final buy (`CurveBuyRefunded`), else 0n. */
  refundWei: bigint;
}

export interface CurveSellResult {
  hash: Hash;
  quoteOut: bigint;
}

/**
 * `curve.buy(wei, minTokensOut, recipient)` with `value = wei` (native pair). `minTokensOut` is a
 * price bound: a clamped fill at the quoted rate still succeeds, so size it from the rate.
 */
export async function curveBuy(account: LocalAccount, curve: Address, wei: bigint, minTokensOut: bigint, recipient: Address): Promise<CurveBuyResult> {
  if (wei <= 0n) throw new Error("curveBuy: wei must be positive");
  const receipt = await sendTx(account, (wallet) =>
    wallet.writeContract({ address: curve, abi: curveAbi, functionName: "buy", args: [wei, minTokensOut, getAddress(recipient)], value: wei }),
  );
  const hash = receipt.transactionHash;
  const buys = parseEventLogs({ abi: curveAbi, eventName: "CurveBuy", logs: receipt.logs, args: { buyer: account.address } });
  const buy = buys[0];
  if (!buy) throw new Error(`curveBuy ${hash}: no CurveBuy event`);
  const refunds = parseEventLogs({ abi: curveAbi, eventName: "CurveBuyRefunded", logs: receipt.logs, args: { buyer: account.address } });
  return { hash, tokensOut: buy.args.tokensOut, refundWei: refunds[0]?.args.refund ?? 0n };
}

/** Approves the curve if needed, then `curve.sell(tokensIn, minQuoteOut, recipient)`. */
export async function curveSell(account: LocalAccount, curve: Address, tokensIn: bigint, minQuoteOut: bigint, recipient: Address): Promise<CurveSellResult> {
  if (tokensIn <= 0n) throw new Error("curveSell: tokensIn must be positive");
  const client = publicClient();
  const token = await client.readContract({ address: curve, abi: curveAbi, functionName: "token" });
  const allowance = await client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [account.address, curve] });
  if (allowance < tokensIn) {
    await sendTx(account, (wallet) => wallet.writeContract({ address: token, abi: tokenAbi, functionName: "approve", args: [curve, tokensIn] }), client);
  }
  const receipt = await sendTx(
    account,
    (wallet) => wallet.writeContract({ address: curve, abi: curveAbi, functionName: "sell", args: [tokensIn, minQuoteOut, getAddress(recipient)] }),
    client,
  );
  const hash = receipt.transactionHash;
  const sells = parseEventLogs({ abi: curveAbi, eventName: "CurveSell", logs: receipt.logs, args: { seller: account.address } });
  const sell = sells[0];
  if (!sell) throw new Error(`curveSell ${hash}: no CurveSell event`);
  return { hash, quoteOut: sell.args.quoteOut };
}
