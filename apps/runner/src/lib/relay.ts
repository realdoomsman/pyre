import { isSolAddress, type SerializedInstruction } from "@pyre/chain";
import { getAddress, type Address, type Hash, type Hex } from "viem";

/*
 * Relay (https://api.relay.link) — one Solana transaction that swaps treasury SOL into USDC on
 * Ethereum mainnet delivered straight to a recipient. Used by the credit-funding flow:
 * `quoteSolToUsdc` asks for an EXACT_OUTPUT quote (the recipient receives exactly the USD amount),
 * the caller signs `quote.deposit` (instructions + address lookup tables, one v0 transaction) with
 * the treasury Solana keypair, and `waitForRelayFill` polls the intent until Relay reports the
 * destination-chain fill. Verified 2026-10-04 against the live API: one `deposit` step whose single
 * item carries `instructions` (base58 keys, hex data; the depository's `DepositNative`) and
 * `addressLookupTableAddresses`.
 */

export const RELAY_API = "https://api.relay.link";
export const ETHEREUM_CHAIN_ID = 1;
/** Relay's chain id for Solana mainnet. */
export const SOLANA_CHAIN_ID = 792703809;
/** Relay's currency id for native SOL (the system program address). */
export const SOL_NATIVE = "11111111111111111111111111111111";
/** USDC on Ethereum mainnet (6 decimals). */
export const USDC_MAINNET: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
/** A quote whose USD value of the output is below this fraction of what was asked is refused. */
export const MIN_OUTPUT_RATIO = 0.98;

export interface RelayQuote {
  requestId: Hex;
  /** Recipient of the USDC on Ethereum (checksummed). */
  recipient: Address;
  /** USDC units (6 dec) the recipient receives. */
  usdcUnits: bigint;
  /** Lamports the deposit spends: swap input + relayer fees (the Solana network fee is on top). */
  lamports: bigint;
  /** Relay's USD valuation of the output. */
  amountOutUsd: number;
  /** Relay's USD valuation of the input, i.e. the all-in cost. */
  amountInUsd: number;
  /** The single Solana deposit transaction, signed by the sender alone. */
  deposit: { instructions: SerializedInstruction[]; lookupTables: string[] };
}

interface Currency {
  amount?: string;
  amountUsd?: string;
  currency?: { address?: string; chainId?: number };
}

interface QuoteResponse {
  requestId?: string;
  steps?: Array<{ kind?: string; items?: Array<{ data?: { instructions?: SerializedInstruction[]; addressLookupTableAddresses?: string[] } }> }>;
  details?: { recipient?: string; currencyIn?: Currency; currencyOut?: Currency };
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

const isInstruction = (ix: unknown): ix is SerializedInstruction => {
  const i = ix as Partial<SerializedInstruction> | null;
  return !!i && typeof i.programId === "string" && typeof i.data === "string" && /^(?:[0-9a-fA-F]{2})+$/.test(i.data) && Array.isArray(i.keys) && i.keys.every((k) => k && typeof k.pubkey === "string" && typeof k.isSigner === "boolean" && typeof k.isWritable === "boolean");
};

/**
 * EXACT_OUTPUT quote: `recipient` receives exactly `usdcUnits` of USDC on Ethereum; the treasury
 * Solana wallet `sender` pays `lamports` of native SOL. Refuses quotes whose output is worth <
 * MIN_OUTPUT_RATIO of the requested dollars, whose recipient/destination/input differ from what was
 * asked, that need a signature from anyone but `sender`, or that need more than one origin
 * transaction — the flow is single-send by design so a crash can never half-execute.
 */
export async function quoteSolToUsdc(sender: string, recipient: Address, usdcUnits: bigint): Promise<RelayQuote> {
  if (usdcUnits <= 0n) throw new RelayQuoteError("usdcUnits must be positive");
  if (!isSolAddress(sender)) throw new RelayQuoteError(`sender ${sender} is not a Solana address`);
  const body = {
    user: sender,
    originChainId: SOLANA_CHAIN_ID,
    destinationChainId: ETHEREUM_CHAIN_ID,
    originCurrency: SOL_NATIVE,
    destinationCurrency: USDC_MAINNET,
    recipient: getAddress(recipient),
    tradeType: "EXACT_OUTPUT",
    amount: usdcUnits.toString(),
  };
  const q = await fetchJson<QuoteResponse>(`${RELAY_API}/quote`, { method: "POST", body: JSON.stringify(body) });
  const step = q.steps?.[0];
  const item = step?.items?.[0]?.data;
  if (!q.requestId || !/^0x[0-9a-fA-F]{64}$/.test(q.requestId)) throw new RelayQuoteError("quote has no requestId");
  if (!q.steps || q.steps.length !== 1 || step?.kind !== "transaction" || step.items?.length !== 1 || !item) {
    throw new RelayQuoteError(`quote needs ${q.steps?.length ?? 0} step(s); expected exactly one transaction`);
  }
  const instructions = item.instructions;
  const lookupTables = item.addressLookupTableAddresses ?? [];
  if (!Array.isArray(instructions) || instructions.length === 0 || !instructions.every(isInstruction)) throw new RelayQuoteError("quote transaction is not a Solana instruction list");
  if (!Array.isArray(lookupTables) || !lookupTables.every((a) => typeof a === "string" && isSolAddress(a))) throw new RelayQuoteError("quote lookup tables are not Solana addresses");
  for (const ix of instructions) {
    const foreign = ix.keys.find((k) => k.isSigner && k.pubkey !== sender);
    if (foreign) throw new RelayQuoteError(`quote instruction needs a signature from ${foreign.pubkey}, not the treasury`);
  }
  const d = q.details;
  const out = d?.currencyOut;
  const input = d?.currencyIn;
  if (!d?.recipient || getAddress(d.recipient) !== getAddress(recipient)) throw new RelayQuoteError("quote recipient does not match");
  if (!out?.currency?.address || getAddress(out.currency.address) !== USDC_MAINNET || out.currency.chainId !== ETHEREUM_CHAIN_ID) {
    throw new RelayQuoteError("quote output is not USDC on Ethereum");
  }
  if (input?.currency?.address !== SOL_NATIVE || input.currency.chainId !== SOLANA_CHAIN_ID) throw new RelayQuoteError("quote input is not native SOL on Solana");
  const outUnits = BigInt(out.amount ?? "0");
  if (outUnits < usdcUnits) throw new RelayQuoteError(`quote delivers ${outUnits} USDC units; asked ${usdcUnits}`);
  const amountOutUsd = Number(out.amountUsd ?? "0");
  const requestedUsd = Number(usdcUnits) / 1e6;
  if (!(amountOutUsd >= requestedUsd * MIN_OUTPUT_RATIO)) {
    throw new RelayQuoteError(`quote output worth $${amountOutUsd.toFixed(2)} for $${requestedUsd.toFixed(2)} requested (< ${MIN_OUTPUT_RATIO * 100}%)`);
  }
  const lamports = BigInt(input.amount ?? "0");
  if (lamports <= 0n || lamports >= 1n << 64n) throw new RelayQuoteError(`quote input ${lamports} lamports is out of range`);
  // The deposit carries its amount as a little-endian u64 (`DepositNative`, like a system transfer):
  // the quoted lamports must be what the transaction actually moves.
  const amountLe = Buffer.alloc(8);
  amountLe.writeBigUInt64LE(lamports);
  if (!instructions.some((ix) => Buffer.from(ix.data, "hex").includes(amountLe))) throw new RelayQuoteError(`quote instructions do not move the quoted ${lamports} lamports`);
  return {
    requestId: q.requestId as Hex,
    recipient: getAddress(recipient),
    usdcUnits: outUnits,
    lamports,
    amountOutUsd,
    amountInUsd: Number(input.amountUsd ?? "0"),
    deposit: { instructions, lookupTables },
  };
}

/** Relay intent lifecycle. `unknown` = no deposit seen yet; the rest per docs.relay.link/references/api/get-intents-status-v3. */
export type RelayStatus = "unknown" | "waiting" | "depositing" | "pending" | "submitted" | "delayed" | "success" | "refund" | "failure";

export interface RelayIntent {
  status: RelayStatus;
  /** Origin-chain deposit transactions (Solana signatures; 0x hashes for legacy Robinhood deposits). */
  inTxHashes: string[];
  /** Destination-chain fill transactions. */
  txHashes: Hash[];
}

export async function getRelayIntent(requestId: Hex): Promise<RelayIntent> {
  const r = await fetchJson<{ status?: string; inTxHashes?: string[]; txHashes?: string[] }>(`${RELAY_API}/intents/status?requestId=${requestId}`);
  return { status: (r.status ?? "unknown") as RelayStatus, inTxHashes: r.inTxHashes ?? [], txHashes: (r.txHashes ?? []) as Hash[] };
}

export type RelayFill = { outcome: "success"; fillTx: Hash | null } | { outcome: "refund" | "failure"; status: RelayStatus } | { outcome: "timeout"; status: RelayStatus };

/**
 * Polls the intent until it settles or `deadlineMs` passes. `timeout` is not terminal: the deposit
 * is with Relay and the fill may still land, so the caller keeps the row in flight instead of
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
