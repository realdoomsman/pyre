import { PublicKey, TransactionInstruction, type Keypair, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { MAX_TX_VERSION, SOLANA_COMMITMENT, connection } from "./connection.js";
import { COMPUTE_UNITS } from "./fees.js";
import { sendInstructions, type SolanaTxResult } from "./send.js";

/** SPL Memo v2. */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/**
 * Burn attestation on Solana: a memo-only transaction from the treasury carrying
 *   pyre:burn:v1:<sha256 hex of the revenue event ids>
 * — the same digest the Robinhood Chain attestation embeds in calldata, so both explorers show
 * the same 32 bytes for one buyback-and-burn.
 */
export const ATTESTATION_MEMO_PREFIX = "pyre:burn:v1:";
export const ATTESTATION_VERSION = 1;

export function memoInstruction(text: string, signer?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: signer ? [{ pubkey: signer, isSigner: true, isWritable: false }] : [], data: Buffer.from(text, "utf8") });
}

/** `pyre:burn:v1:<64 hex>`; accepts the digest with or without a 0x prefix. */
export function encodeAttestationMemo(digestHex: string): string {
  const hex = (digestHex.startsWith("0x") ? digestHex.slice(2) : digestHex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("attestation digest must be 32 bytes of hex");
  return `${ATTESTATION_MEMO_PREFIX}${hex}`;
}

/** The embedded digest (0x-prefixed, like `attestationHash`) when `text` is a Pyre attestation memo, else null. */
export function parseAttestationMemo(text: string): { digestHex: `0x${string}`; version: number } | null {
  const m = /^pyre:burn:v(\d+):([0-9a-f]{64})$/.exec(text.trim());
  if (!m) return null;
  return { digestHex: `0x${m[2]!}`, version: Number(m[1]) };
}

/** Memo-only transaction from `account`; the memo program requires no accounts, so the payer's signature is the only one. */
export async function attestOnSolana(account: Keypair, digestHex: string): Promise<SolanaTxResult> {
  return sendInstructions(account, [memoInstruction(encodeAttestationMemo(digestHex))], { computeUnits: COMPUTE_UNITS.memo });
}

const isParsed = (ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction => "parsed" in ix;

/** Every memo text in the transaction (top level and inner). Exported for tests. */
export function memosIn(tx: ParsedTransactionWithMeta): string[] {
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions)];
  const memos: string[] = [];
  for (const ix of all) {
    if (!ix.programId.equals(MEMO_PROGRAM_ID)) continue;
    if (isParsed(ix)) {
      if (typeof ix.parsed === "string") memos.push(ix.parsed);
    } else {
      memos.push(Buffer.from(bs58.decode(ix.data)).toString("utf8"));
    }
  }
  return memos;
}

/** The attestation carried by a confirmed transaction, or null when it has none (or failed). */
export async function readAttestationOnSolana(signature: string): Promise<{ digestHex: `0x${string}`; version: number } | null> {
  const tx = await connection()
    .getParsedTransaction(signature, { commitment: SOLANA_COMMITMENT, maxSupportedTransactionVersion: MAX_TX_VERSION })
    .catch(() => null);
  if (!tx || tx.meta?.err) return null;
  for (const memo of memosIn(tx)) {
    const parsed = parseAttestationMemo(memo);
    if (parsed) return parsed;
  }
  return null;
}
