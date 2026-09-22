import { PublicKey, SystemProgram, type Keypair, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import { MAX_TX_VERSION, SOLANA_COMMITMENT, connection } from "./connection.js";
import { COMPUTE_UNITS } from "./fees.js";
import { pubkey } from "./keys.js";
import { sendInstructions, type SolanaTxResult } from "./send.js";

export async function getSolBalance(address: string): Promise<bigint> {
  return BigInt(await connection().getBalance(pubkey(address), SOLANA_COMMITMENT));
}

/** System transfer of `lamports` from a custodial keypair. Resolves once confirmed. */
export async function transferSol(from: Keypair, to: string, lamports: bigint): Promise<SolanaTxResult> {
  if (lamports <= 0n) throw new Error("transferSol: lamports must be positive");
  const ix = SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: pubkey(to), lamports });
  return sendInstructions(from, [ix], { computeUnits: COMPUTE_UNITS.transfer });
}

export interface SolTransferCheck {
  ok: boolean;
  from: string;
  lamports: bigint;
  /** Set when `ok` is false. */
  reason?: string;
}

interface ParsedSystemTransfer {
  source: string;
  destination: string;
  lamports: bigint;
}

const isParsed = (ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction => "parsed" in ix;

/** Every `system.transfer` in the transaction (top level and inner), as the RPC's jsonParsed view reports them. */
export function systemTransfers(tx: ParsedTransactionWithMeta): ParsedSystemTransfer[] {
  const out: ParsedSystemTransfer[] = [];
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions)];
  for (const ix of all) {
    if (!isParsed(ix) || !ix.programId.equals(SystemProgram.programId)) continue;
    const parsed = ix.parsed as { type?: string; info?: { source?: string; destination?: string; lamports?: number | string } };
    if (parsed.type !== "transfer" || !parsed.info?.source || !parsed.info.destination || parsed.info.lamports === undefined) continue;
    out.push({ source: parsed.info.source, destination: parsed.info.destination, lamports: BigInt(parsed.info.lamports) });
  }
  return out;
}

/** Pure check over a parsed transaction; exported for tests. Sums every system transfer to `to` (from `from` when given). */
export function checkSolTransfer(tx: ParsedTransactionWithMeta | null, opts: { to: string; minLamports: bigint; from?: string }): SolTransferCheck {
  if (!tx || !tx.meta) return { ok: false, from: PublicKey.default.toBase58(), lamports: 0n, reason: "not-found" };
  const transfers = systemTransfers(tx).filter((t) => t.destination === opts.to);
  const payer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58() ?? PublicKey.default.toBase58();
  const from = transfers[0]?.source ?? payer;
  const lamports = transfers.filter((t) => !opts.from || t.source === opts.from).reduce((sum, t) => sum + t.lamports, 0n);
  if (tx.meta.err) return { ok: false, from, lamports: 0n, reason: "reverted" };
  if (transfers.length === 0) return { ok: false, from, lamports: 0n, reason: "wrong-recipient" };
  if (opts.from && lamports === 0n) return { ok: false, from, lamports: 0n, reason: "wrong-sender" };
  if (lamports < opts.minLamports) return { ok: false, from, lamports, reason: "insufficient" };
  return { ok: true, from: opts.from ?? from, lamports };
}

/**
 * Verifies an inbound native transfer by signature: confirmed, not failed, at least `minLamports`
 * moved to `to` by system transfers (from `from` when given). Wallet-to-wallet sends from Phantom
 * and the like are plain system transfers; CPI transfers inside other programs are counted too
 * since the parsed view includes inner instructions.
 */
export async function verifySolTransfer(signature: string, opts: { to: string; minLamports: bigint; from?: string }): Promise<SolTransferCheck> {
  const tx = await connection()
    .getParsedTransaction(signature, { commitment: SOLANA_COMMITMENT, maxSupportedTransactionVersion: MAX_TX_VERSION })
    .catch(() => null);
  return checkSolTransfer(tx, opts);
}
