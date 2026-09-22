import { PublicKey, SystemProgram, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { checkSolTransfer } from "./native.js";

const PAYER = "Eb42EjDFipJzBbPcqVd3NsZ8WFsZQb5yEzJHZ6y3n7j";
const TO = "Ge9qWzSr9ZgdF7LjFqjypEEgpwgZkeU48iHxVqUYGkG8";
const OTHER = "otCKk1NkLdsXxMFDWQhwNzrLdCTQ8B7vGTRoznWktWY";

const transfer = (source: string, destination: string, lamports: number) => ({ programId: SystemProgram.programId, program: "system", parsed: { type: "transfer", info: { source, destination, lamports } } });

function tx(instructions: unknown[], opts: { err?: unknown; inner?: unknown[] } = {}): ParsedTransactionWithMeta {
  return {
    slot: 1,
    blockTime: 1,
    meta: { err: opts.err ?? null, fee: 5000, preBalances: [], postBalances: [], innerInstructions: opts.inner ? [{ index: 0, instructions: opts.inner }] : [], logMessages: [] },
    transaction: { signatures: ["sig"], message: { accountKeys: [{ pubkey: new PublicKey(PAYER), signer: true, writable: true }], instructions, recentBlockhash: "x" } },
  } as unknown as ParsedTransactionWithMeta;
}

describe("checkSolTransfer", () => {
  it("accepts a system transfer to the recipient at or above the minimum", () => {
    expect(checkSolTransfer(tx([transfer(PAYER, TO, 1_000_000_000)]), { to: TO, minLamports: 1_000_000_000n })).toEqual({ ok: true, from: PAYER, lamports: 1_000_000_000n });
  });

  it("sums several transfers to the recipient, including CPI ones", () => {
    const t = tx([transfer(PAYER, TO, 600_000_000)], { inner: [transfer(PAYER, TO, 400_000_000)] });
    expect(checkSolTransfer(t, { to: TO, minLamports: 1_000_000_000n })).toMatchObject({ ok: true, lamports: 1_000_000_000n });
  });

  it("reports why a transfer does not count", () => {
    expect(checkSolTransfer(null, { to: TO, minLamports: 1n })).toMatchObject({ ok: false, reason: "not-found" });
    expect(checkSolTransfer(tx([transfer(PAYER, TO, 10)], { err: { InstructionError: [0, "Custom"] } }), { to: TO, minLamports: 1n })).toMatchObject({ ok: false, reason: "reverted" });
    expect(checkSolTransfer(tx([transfer(PAYER, OTHER, 10)]), { to: TO, minLamports: 1n })).toMatchObject({ ok: false, reason: "wrong-recipient" });
    expect(checkSolTransfer(tx([transfer(OTHER, TO, 10)]), { to: TO, minLamports: 1n, from: PAYER })).toMatchObject({ ok: false, reason: "wrong-sender", from: OTHER });
    expect(checkSolTransfer(tx([transfer(PAYER, TO, 10)]), { to: TO, minLamports: 11n })).toMatchObject({ ok: false, reason: "insufficient", lamports: 10n });
  });

  it("only counts the named sender's transfers when `from` is given", () => {
    const t = tx([transfer(OTHER, TO, 900), transfer(PAYER, TO, 100)]);
    expect(checkSolTransfer(t, { to: TO, minLamports: 100n, from: PAYER })).toEqual({ ok: true, from: PAYER, lamports: 100n });
    expect(checkSolTransfer(t, { to: TO, minLamports: 101n, from: PAYER })).toMatchObject({ ok: false, reason: "insufficient" });
  });
});
