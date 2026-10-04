import { setTimeout as sleep } from "node:timers/promises";
import {
  ComputeBudgetProgram,
  PublicKey,
  SendTransactionError,
  TransactionExpiredBlockheightExceededError,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type Keypair,
  type SimulatedTransactionResponse,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { withSendLock } from "../sendLock.js";
import { MAX_TX_VERSION, SOLANA_COMMITMENT, connection } from "./connection.js";
import { computeUnitPrice } from "./fees.js";

/**
 * Every state-changing Solana transaction goes through `sendInstructions`: compute budget
 * prepended, v0 message signed by the payer (plus any extra signers such as a fresh mint), sent
 * with preflight, and confirmed against the blockhash it was built with — all under the payer's
 * cross-process send lock, the Solana counterpart of `sendTx` on the EVM side. A blockhash that
 * expires before the transaction lands cannot land later, so the send is rebuilt on a fresh one —
 * but only once that is provable (`expiredOutcome`); otherwise it throws
 * `SolanaTransactionUnconfirmedError` carrying the blockhash's `lastValidBlockHeight`.
 */
export interface SolanaTxResult {
  signature: string;
  /** Slot the transaction was confirmed in (the venue's "block"). */
  slot: number;
  /** Full confirmed transaction (v0-capable) for balance/event parsing. */
  tx: VersionedTransactionResponse;
}

export interface SendOptions {
  computeUnits: number;
  /** Signers besides the payer (a new mint keypair on create). */
  signers?: Keypair[];
  /** Address lookup tables the v0 message may compress account keys into. */
  lookupTables?: AddressLookupTableAccount[];
  /**
   * Called with the signature right after each broadcast, before confirmation (again with the new
   * signature if an expired blockhash forces a re-sign). Lets a caller persist "sent" in the same
   * tick as the broadcast; a throw propagates as-is and the transaction may still land.
   */
  onBroadcast?: (signature: string) => Promise<void> | void;
}

/** The transaction was processed and failed, or was rejected at preflight: nothing it was meant to move has moved. */
export class SolanaTransactionFailedError extends Error {
  constructor(
    readonly signature: string | null,
    readonly err: unknown,
    readonly logs: string[],
  ) {
    super(`solana transaction ${signature ?? "(preflight)"} failed: ${typeof err === "string" ? err : JSON.stringify(err)}${logs.length ? `\n${logs.slice(-8).join("\n")}` : ""}`);
    this.name = "SolanaTransactionFailedError";
  }
}

/** Broadcast, but its status could not be read. It may still land: callers that moved funds MUST NOT treat this as "never sent". */
export class SolanaTransactionUnconfirmedError extends Error {
  constructor(
    readonly signature: string,
    override readonly cause?: unknown,
    /** Block height past which the transaction's blockhash can no longer land (when known): once the finalized height exceeds it and the signature is still unknown, it never will. */
    readonly lastValidBlockHeight?: number,
  ) {
    super(`solana transaction ${signature} could not be confirmed`);
    this.name = "SolanaTransactionUnconfirmedError";
  }
}

const MAX_BLOCKHASH_ATTEMPTS = 3;
const FETCH_ATTEMPTS = 8;
/** After a blockhash expires, how long to wait for a provable outcome (finalized lags confirmed by ~32 slots ≈ 13 s). */
const EXPIRY_POLLS = 15;
const EXPIRY_POLL_MS = 2_000;

function writableKeys(instructions: TransactionInstruction[]): PublicKey[] {
  const seen: Record<string, PublicKey> = {};
  for (const ix of instructions) for (const k of ix.keys) if (k.isWritable) seen[k.pubkey.toBase58()] = k.pubkey;
  return Object.values(seen);
}

function budgetInstructions(units: number, microLamports: number): TransactionInstruction[] {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
}

/** Confirmed transaction by signature; `getTransaction` can lag confirmation by a moment, so retry briefly. */
export async function fetchTransaction(signature: string, conn: Connection = connection()): Promise<VersionedTransactionResponse> {
  for (let attempt = 0; ; attempt++) {
    const tx = await conn.getTransaction(signature, { commitment: SOLANA_COMMITMENT, maxSupportedTransactionVersion: MAX_TX_VERSION });
    if (tx) return tx;
    if (attempt >= FETCH_ATTEMPTS) throw new SolanaTransactionUnconfirmedError(signature);
    await sleep(500 * (attempt + 1));
  }
}

/** A preflight (simulation) rejection carries the program logs; anything else is a transport error and rethrown as is. */
function preflightError(err: unknown): SolanaTransactionFailedError | undefined {
  if (!(err instanceof SendTransactionError)) return undefined;
  const { message, logs } = err.transactionError;
  return new SolanaTransactionFailedError(null, message, logs ?? []);
}

/**
 * After `confirmTransaction` reports the blockhash expired: did `signature` land? Status is read with
 * full history search (a node that pruned its recent-status cache would otherwise say "unknown").
 * "landed" once confirmed/finalized; "expired" only when the FINALIZED block height is past
 * `lastValidBlockHeight` and the signature is still unknown — the one case where signing a second
 * transaction cannot double-spend. A `processed` status keeps waiting; anything unproven → "unknown".
 */
export async function expiredOutcome(conn: Connection, signature: string, lastValidBlockHeight: number): Promise<"landed" | "expired" | "unknown"> {
  const statusOf = async () => (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  for (let poll = 0; poll < EXPIRY_POLLS; poll++) {
    if (poll > 0) await sleep(EXPIRY_POLL_MS);
    const status = await statusOf();
    if (status) {
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        if (status.err) throw new SolanaTransactionFailedError(signature, status.err, []);
        return "landed";
      }
      continue; // processed: may still confirm
    }
    if ((await conn.getBlockHeight("finalized")) <= lastValidBlockHeight) continue;
    // Re-read after the height check: a status seen now is from a slot at or below that height.
    if (!(await statusOf())) return "expired";
  }
  return "unknown";
}

async function sendLocked(payer: Keypair, instructions: TransactionInstruction[], opts: SendOptions): Promise<SolanaTxResult> {
  const conn = connection();
  const microLamports = await computeUnitPrice(conn, writableKeys(instructions));
  const all = [...budgetInstructions(opts.computeUnits, microLamports), ...instructions];
  for (let attempt = 0; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(SOLANA_COMMITMENT);
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: all }).compileToV0Message(opts.lookupTables);
    const tx = new VersionedTransaction(message);
    tx.sign([payer, ...(opts.signers ?? [])]);
    let signature: string;
    try {
      signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: SOLANA_COMMITMENT, maxRetries: 5 });
    } catch (err) {
      throw preflightError(err) ?? err;
    }
    await opts.onBroadcast?.(signature);
    try {
      const { value } = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, SOLANA_COMMITMENT);
      if (value.err) {
        const failed = await conn.getTransaction(signature, { commitment: SOLANA_COMMITMENT, maxSupportedTransactionVersion: MAX_TX_VERSION }).catch(() => null);
        throw new SolanaTransactionFailedError(signature, value.err, failed?.meta?.logMessages ?? []);
      }
    } catch (err) {
      if (err instanceof SolanaTransactionFailedError) throw err;
      if (!(err instanceof TransactionExpiredBlockheightExceededError)) throw new SolanaTransactionUnconfirmedError(signature, err, lastValidBlockHeight);
      // The blockhash is dead: either the transaction landed just before expiry or it never will.
      // A second transfer is signed only once the first provably can no longer land.
      const outcome = await expiredOutcome(conn, signature, lastValidBlockHeight);
      if (outcome === "unknown") throw new SolanaTransactionUnconfirmedError(signature, err, lastValidBlockHeight);
      if (outcome === "expired") {
        if (attempt + 1 >= MAX_BLOCKHASH_ATTEMPTS) throw new SolanaTransactionUnconfirmedError(signature, err, lastValidBlockHeight);
        continue;
      }
    }
    let full: VersionedTransactionResponse;
    try {
      full = await fetchTransaction(signature, conn);
    } catch (err) {
      if (err instanceof SolanaTransactionUnconfirmedError) throw new SolanaTransactionUnconfirmedError(signature, err, lastValidBlockHeight);
      throw err;
    }
    if (full.meta?.err) throw new SolanaTransactionFailedError(signature, full.meta.err, full.meta.logMessages ?? []);
    return { signature, slot: full.slot, tx: full };
  }
}

/** Sends `instructions` from `payer` and resolves once confirmed; see the module comment. */
export function sendInstructions(payer: Keypair, instructions: TransactionInstruction[], opts: SendOptions): Promise<SolanaTxResult> {
  return withSendLock(payer.publicKey.toBase58(), () => sendLocked(payer, instructions, opts));
}

/** An instruction as an API hands it over (Relay's SVM steps): base58 keys, hex-encoded data. */
export interface SerializedInstruction {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

/** Decodes a serialized instruction; refuses one that needs a signature from anyone but `payer`. Exported for tests. */
export function decodeInstruction(ix: SerializedInstruction, payer: PublicKey): TransactionInstruction {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(ix.data)) throw new Error(`instruction for ${ix.programId} carries non-hex data`);
  const keys = ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable }));
  const foreign = keys.find((k) => k.isSigner && !k.pubkey.equals(payer));
  if (foreign) throw new Error(`instruction for ${ix.programId} needs a signature from ${foreign.pubkey.toBase58()}, not the payer`);
  return new TransactionInstruction({ programId: new PublicKey(ix.programId), keys, data: Buffer.from(ix.data, "hex") });
}

/**
 * Sends instructions built by a third party (a Relay deposit) from `payer` through
 * `sendInstructions`, compressing keys with the given lookup tables. Everything is decoded and
 * every table resolved before anything is signed, so a throw before `onBroadcast` means nothing
 * was sent.
 */
export async function sendSerializedInstructions(
  payer: Keypair,
  instructions: SerializedInstruction[],
  opts: Omit<SendOptions, "lookupTables" | "signers"> & { lookupTables?: string[] },
): Promise<SolanaTxResult> {
  if (instructions.length === 0) throw new Error("no instructions to send");
  const decoded = instructions.map((ix) => decodeInstruction(ix, payer.publicKey));
  const conn = connection();
  const lookupTables = await Promise.all(
    (opts.lookupTables ?? []).map(async (address) => {
      const { value } = await conn.getAddressLookupTable(new PublicKey(address), { commitment: SOLANA_COMMITMENT });
      if (!value) throw new Error(`address lookup table ${address} not found`);
      return value;
    }),
  );
  return sendInstructions(payer, decoded, { computeUnits: opts.computeUnits, onBroadcast: opts.onBroadcast, lookupTables });
}

export interface SimulationResult {
  unitsConsumed: number;
  err: unknown | null;
  logs: string[];
  /** Payer lamports after the simulated transaction (base fee included), when requested. */
  payerLamportsAfter: bigint | null;
}

/**
 * Simulates `instructions` as if `payer` signed (signatures are not verified, so the payer's key is
 * not needed); reports compute units and the payer's post-balance so a launch can be costed.
 */
export async function simulateInstructions(payer: PublicKey, instructions: TransactionInstruction[], computeUnits: number, microLamports: number): Promise<SimulationResult> {
  const conn = connection();
  const all = [...budgetInstructions(computeUnits, microLamports), ...instructions];
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: all }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const { value }: { value: SimulatedTransactionResponse } = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: SOLANA_COMMITMENT,
    accounts: { encoding: "base64", addresses: [payer.toBase58()] },
  });
  const after = value.accounts?.[0]?.lamports;
  return { unitsConsumed: value.unitsConsumed ?? 0, err: value.err, logs: value.logs ?? [], payerLamportsAfter: after === undefined || after === null ? null : BigInt(after) };
}

/** Lamport change of `address` in a confirmed transaction (positive = received), tx fee excluded for the payer. Balances index static keys, then lookup-loaded writable, then readonly. */
export function lamportDelta(tx: VersionedTransactionResponse, address: PublicKey): bigint {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  const index = keys.keySegments().flat().findIndex((k) => k.equals(address));
  if (index < 0 || !tx.meta) return 0n;
  const delta = BigInt(tx.meta.postBalances[index] ?? 0) - BigInt(tx.meta.preBalances[index] ?? 0);
  return index === 0 ? delta + BigInt(tx.meta.fee) : delta;
}
