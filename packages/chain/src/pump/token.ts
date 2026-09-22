import { createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { SOLANA_COMMITMENT, connection } from "../solana/connection.js";
import { COMPUTE_UNITS } from "../solana/fees.js";
import { pubkey } from "../solana/keys.js";
import { sendInstructions, type SolanaTxResult } from "../solana/send.js";
import { PUMP_TOKEN_DECIMALS, readPumpState, type PumpState } from "./read.js";

/**
 * SPL/Token-2022 helpers for a pump coin. The mint's owner program is read from chain every time:
 * create_v2 coins are Token-2022, pre-2026 coins plain SPL Token, and both must work.
 */
function mintProgram(state: PumpState): PublicKey {
  if (!state.tokenProgram) throw new Error(`pump mint ${state.mint.toBase58()} does not exist`);
  return state.tokenProgram;
}

/** Balance of `owner`'s associated token account for the mint; 0 when it has none. */
export async function pumpTokenBalance(mint: string, owner: string): Promise<bigint> {
  const state = await readPumpState(mint);
  if (!state.tokenProgram) return 0n;
  const ata = getAssociatedTokenAddressSync(state.mint, pubkey(owner), true, state.tokenProgram);
  const info = await connection().getAccountInfo(ata, SOLANA_COMMITMENT);
  return info ? unpackAccount(ata, info, state.tokenProgram).amount : 0n;
}

/** `transferChecked` to `to`'s ATA (created idempotently, rent paid by `from`). */
export async function transferPumpToken(from: Keypair, mint: string, to: string, units: bigint): Promise<SolanaTxResult> {
  if (units <= 0n) throw new Error("transferPumpToken: units must be positive");
  const state = await readPumpState(mint);
  const program = mintProgram(state);
  const toKey = pubkey(to);
  const fromAta = getAssociatedTokenAddressSync(state.mint, from.publicKey, true, program);
  const toAta = getAssociatedTokenAddressSync(state.mint, toKey, true, program);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(from.publicKey, toAta, toKey, state.mint, program),
    createTransferCheckedInstruction(fromAta, state.mint, toAta, from.publicKey, units, PUMP_TOKEN_DECIMALS, [], program),
  ];
  return sendInstructions(from, ixs, { computeUnits: COMPUTE_UNITS.burn });
}

/** `burnChecked` from the owner's ATA; reduces the mint supply (pump mints have no authority, so supply only ever falls). */
export async function burnPumpToken(owner: Keypair, mint: string, units: bigint): Promise<SolanaTxResult & { burnedUnits: bigint }> {
  if (units <= 0n) throw new Error("burnPumpToken: units must be positive");
  const state = await readPumpState(mint);
  const program = mintProgram(state);
  const ata = getAssociatedTokenAddressSync(state.mint, owner.publicKey, true, program);
  const ix = createBurnCheckedInstruction(ata, state.mint, owner.publicKey, units, PUMP_TOKEN_DECIMALS, [], program);
  const res = await sendInstructions(owner, [ix], { computeUnits: COMPUTE_UNITS.burn });
  return { ...res, burnedUnits: units };
}
