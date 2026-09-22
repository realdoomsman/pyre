import { ROBINHOOD_CHAIN_ID } from "@pyre/chain";
import { getAddress, type Address, type Hash, type Hex } from "viem";

/*
 * Relay (https://api.relay.link) — one Robinhood-side transaction that swaps treasury ETH into
 * USDC on Ethereum mainnet delivered straight to a recipient. Used by the credit-funding flow:
 * `quoteEthToUsdc` asks for an EXACT_OUTPUT quote (the recipient receives exactly the USD amount),
 * the caller sends `quote.tx` from the treasury, and `waitForRelayFill` polls the intent until Relay
 * reports the destination-chain fill. Verified 2026-09-21 against the live API.
 */

export const RELAY_API = "https://api.relay.link";
export const ETHEREUM_CHAIN_ID = 1;
/** USDC on Ethereum mainnet (6 decimals). */
export const USDC_MAINNET: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NATIVE = "0x0000000000000000000000000000000000000000";
/** A quote whose USD value of the output is below this fraction of what was asked is refused. */
export const MIN_OUTPUT_RATIO = 0.98;

export interface RelayQuote {
  requestId: Hex;
  /** Recipient of the USDC on Ethereum (checksummed). */
  recipient: Address;
  /** USDC units (6 dec) the recipient receives. */
  usdcUnits: bigint;
  /** ETH (wei) the origin transaction carries: swap input + relayer fees. */
  ethWei: bigint;
  /** Relay's USD valuation of the output. */
  amountOutUsd: number;
  /** Relay's USD valuation of the input, i.e. the all-in cost. */
  amountInUsd: number;
  /** The transaction to send from the treasury on Robinhood Chain. */
  tx: { to: Address; data: Hex; value: bigint; chainId: number; gas?: bigint };
}

interface QuoteResponse {
  requestId?: string;
  steps?: Array<{ kind?: string; items?: Array<{ data?: { to?: string; data?: string; value?: string; chainId?: number; gas?: string } }> }>;
  details?: {
    recipient?: string;
    currencyIn?: { amount?: string; amountUsd?: string };
    currencyOut?: { amount?: string; amountUsd?: string; currency?: { address?: string; chainId?: number } };
  };
  message?: string;
  errorCode?: string;
}

export class RelayQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayQuoteError";
  }
}

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", "content-type": "application/json", ...init?.headers } });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const m = (body as { message?: string; errorCode?: string }) ?? {};
    throw new RelayQuoteError(`relay ${res.status}: ${m.errorCode ?? ""} ${m.message ?? text.slice(0, 200)}`.trim());
  }
  return body as T;
};

/**
 * EXACT_OUTPUT quote: `recipient` receives exactly `usdcUnits` of USDC on Ethereum; the treasury
 * pays `ethWei` on Robinhood Chain. Refuses quotes whose output is worth < MIN_OUTPUT_RATIO of the
 * requested dollars, whose recipient/destination differ from what was asked, or that need more than
 * one origin transaction — the flow is single-send by design so a crash can never half-execute.
 */
export async function quoteEthToUsdc(sender: Address, recipient: Address, usdcUnits: bigint): Promise<RelayQuote> {
  if (usdcUnits <= 0n) throw new RelayQuoteError("usdcUnits must be positive");
  const body = {
    user: getAddress(sender),
    originChainId: ROBINHOOD_CHAIN_ID,
    destinationChainId: ETHEREUM_CHAIN_ID,
    originCurrency: NATIVE,
    destinationCurrency: USDC_MAINNET,
    recipient: getAddress(recipient),
    tradeType: "EXACT_OUTPUT",
    amount: usdcUnits.toString(),
  };
  const q = await fetchJson<QuoteResponse>(`${RELAY_API}/quote`, { method: "POST", body: JSON.stringify(body) });
  const step = q.steps?.[0];
  const item = step?.items?.[0]?.data;
  if (!q.requestId || !/^0x[0-9a-fA-F]{64}$/.test(q.requestId)) throw new RelayQuoteError("quote has no requestId");
  if (!q.steps || q.steps.length !== 1 || step?.kind !== "transaction" || step.items?.length !== 1 || !item?.to || !item.data || item.value === undefined) {
    throw new RelayQuoteError(`quote needs ${q.steps?.length ?? 0} step(s); expected exactly one transaction`);
  }
  if (item.chainId !== ROBINHOOD_CHAIN_ID) throw new RelayQuoteError(`quote transaction targets chain ${item.chainId}, not ${ROBINHOOD_CHAIN_ID}`);
  const d = q.details;
  const out = d?.currencyOut;
  if (!d?.recipient || getAddress(d.recipient) !== getAddress(recipient)) throw new RelayQuoteError("quote recipient does not match");
  if (!out?.currency?.address || getAddress(out.currency.address) !== USDC_MAINNET || out.currency.chainId !== ETHEREUM_CHAIN_ID) {
    throw new RelayQuoteError("quote output is not USDC on Ethereum");
  }
  const outUnits = BigInt(out.amount ?? "0");
  if (outUnits < usdcUnits) throw new RelayQuoteError(`quote delivers ${outUnits} USDC units; asked ${usdcUnits}`);
  const amountOutUsd = Number(out.amountUsd ?? "0");
  const requestedUsd = Number(usdcUnits) / 1e6;
  if (!(amountOutUsd >= requestedUsd * MIN_OUTPUT_RATIO)) {
    throw new RelayQuoteError(`quote output worth $${amountOutUsd.toFixed(2)} for $${requestedUsd.toFixed(2)} requested (< ${MIN_OUTPUT_RATIO * 100}%)`);
  }
  const ethWei = BigInt(item.value);
  const inWei = BigInt(d.currencyIn?.amount ?? "0");
  if (ethWei <= 0n || (inWei > 0n && ethWei !== inWei)) throw new RelayQuoteError(`quote value ${ethWei} wei does not match currencyIn ${inWei}`);
  return {
    requestId: q.requestId as Hex,
    recipient: getAddress(recipient),
    usdcUnits: outUnits,
    ethWei,
    amountOutUsd,
    amountInUsd: Number(d.currencyIn?.amountUsd ?? "0"),
    tx: { to: getAddress(item.to), data: item.data as Hex, value: ethWei, chainId: item.chainId, gas: item.gas ? BigInt(item.gas) : undefined },
  };
}

/** Relay intent lifecycle. `unknown` = no deposit seen yet; the rest per docs.relay.link/references/api/get-intents-status-v3. */
export type RelayStatus = "unknown" | "waiting" | "depositing" | "pending" | "submitted" | "delayed" | "success" | "refund" | "failure";

export interface RelayIntent {
  status: RelayStatus;
  /** Origin-chain deposit transactions. */
  inTxHashes: Hash[];
  /** Destination-chain fill transactions. */
  txHashes: Hash[];
}

export async function getRelayIntent(requestId: Hex): Promise<RelayIntent> {
  const r = await fetchJson<{ status?: string; inTxHashes?: string[]; txHashes?: string[] }>(`${RELAY_API}/intents/status?requestId=${requestId}`);
  return { status: (r.status ?? "unknown") as RelayStatus, inTxHashes: (r.inTxHashes ?? []) as Hash[], txHashes: (r.txHashes ?? []) as Hash[] };
}

export type RelayFill = { outcome: "success"; fillTx: Hash | null } | { outcome: "refund" | "failure"; status: RelayStatus } | { outcome: "timeout"; status: RelayStatus };

/**
 * Polls the intent until it settles or `deadlineMs` passes. `timeout` is not terminal: the ETH is
 * with Relay and the fill may still land, so the caller keeps the row in flight instead of
 * re-sending.
 */
export async function waitForRelayFill(requestId: Hex, deadlineMs: number, opts: { intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<RelayFill> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: RelayStatus = "unknown";
  for (;;) {
    const intent = await getRelayIntent(requestId);
    last = intent.status;
    if (intent.status === "success") return { outcome: "success", fillTx: intent.txHashes[0] ?? null };
    if (intent.status === "refund" || intent.status === "failure") return { outcome: intent.status, status: intent.status };
    if (Date.now() >= deadlineMs) return { outcome: "timeout", status: last };
    await sleep(intervalMs);
  }
}
