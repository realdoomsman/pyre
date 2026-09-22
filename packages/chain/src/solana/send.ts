import { setTimeout as sleep } from "node:timers/promises";
import {
  ComputeBudgetProgram,
  PublicKey,
  SendTransactionError,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Keypair,
  type SimulatedTransactionResponse,
  type TransactionInstruction,
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
 * expires before the transaction lands cannot land later, so the send is rebuilt on a fresh one.
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
  ) {
    super(`solana transaction ${signature} could not be confirmed`);
    this.name = "SolanaTransactionUnconfirmedError";
  }
}

const MAX_BLOCKHASH_ATTEMPTS = 3;
const FETCH_ATTEMPTS = 8;

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

async function sendLocked(payer: Keypair, instructions: TransactionInstruction[], opts: SendOptions): Promise<SolanaTxResult> {
  const conn = connection();
  const microLamports = await computeUnitPrice(conn, writableKeys(instructions));
  const all = [...budgetInstructions(opts.computeUnits, microLamports), ...instructions];
  for (let attempt = 0; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(SOLANA_COMMITMENT);
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer, ...(opts.signers ?? [])]);
    let signature: string;
    try {
      signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: SOLANA_COMMITMENT, maxRetries: 5 });
    } catch (err) {
      throw preflightError(err) ?? err;
    }
    try {
      const { value } = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, SOLANA_COMMITMENT);
      if (value.err) {
        const failed = await conn.getTransaction(signature, { commitment: SOLANA_COMMITMENT, maxSupportedTransactionVersion: MAX_TX_VERSION }).catch(() => null);
        throw new SolanaTransactionFailedError(signature, value.err, failed?.meta?.logMessages ?? []);
      }
    } catch (err) {
      if (err instanceof SolanaTransactionFailedError) throw err;
      if (err instanceof TransactionExpiredBlockheightExceededError) {
        // The blockhash is dead: either the transaction landed just before expiry or it never will.
        const status = (await conn.getSignatureStatuses([signature])).value[0];
        const landed = status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized");
        if (!landed) {
          if (attempt + 1 >= MAX_BLOCKHASH_ATTEMPTS) throw new SolanaTransactionUnconfirmedError(signature, err);
          continue;
        }
        if (status.err) throw new SolanaTransactionFailedError(signature, status.err, []);
      } else {
        throw new SolanaTransactionUnconfirmedError(signature, err);
      }
    }
    const full = await fetchTransaction(signature, conn);
    if (full.meta?.err) throw new SolanaTransactionFailedError(signature, full.meta.err, full.meta.logMessages ?? []);
    return { signature, slot: full.slot, tx: full };
  }
}

/** Sends `instructions` from `payer` and resolves once confirmed; see the module comment. */
export function sendInstructions(payer: Keypair, instructions: TransactionInstruction[], opts: SendOptions): Promise<SolanaTxResult> {
  return withSendLock(payer.publicKey.toBase58(), () => sendLocked(payer, instructions, opts));
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

/** Lamport change of `address` in a confirmed transaction (positive = received), tx fee excluded for the payer. */
export function lamportDelta(tx: VersionedTransactionResponse, address: PublicKey): bigint {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  const index = keys.staticAccountKeys.findIndex((k) => k.equals(address));
  if (index < 0 || !tx.meta) return 0n;
  const delta = BigInt(tx.meta.postBalances[index] ?? 0) - BigInt(tx.meta.preBalances[index] ?? 0);
  return index === 0 ? delta + BigInt(tx.meta.fee) : delta;
}
