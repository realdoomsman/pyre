import { PublicKey, SystemProgram, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { attestationHash } from "../burn.js";
import { MEMO_PROGRAM_ID, encodeAttestationMemo, memoInstruction, memosIn, parseAttestationMemo } from "./memo.js";

const DIGEST = attestationHash(["rev_2", "rev_1"]);

/** Minimal jsonParsed transaction shape with the given instructions. */
function parsedTx(instructions: ParsedTransactionWithMeta["transaction"]["message"]["instructions"], inner: typeof instructions = []): ParsedTransactionWithMeta {
  return {
    slot: 1,
    blockTime: 1,
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [], innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [], logMessages: [] },
    transaction: { signatures: ["sig"], message: { accountKeys: [{ pubkey: PublicKey.default, signer: true, writable: true }], instructions, recentBlockhash: "x" } },
  } as unknown as ParsedTransactionWithMeta;
}

describe("attestation memo", () => {
  it("round-trips the digest with the same bytes the EVM attestation carries", () => {
    const memo = encodeAttestationMemo(DIGEST);
    expect(memo).toBe(`pyre:burn:v1:${DIGEST.slice(2)}`);
    expect(parseAttestationMemo(memo)).toEqual({ digestHex: DIGEST, version: 1 });
    expect(encodeAttestationMemo(DIGEST.slice(2))).toBe(memo);
    expect(memoInstruction(memo).data.toString("utf8")).toBe(memo);
    expect(memoInstruction(memo).programId.equals(MEMO_PROGRAM_ID)).toBe(true);
  });

  it("rejects digests that are not 32 bytes and memos that are not ours", () => {
    expect(() => encodeAttestationMemo("0xabcd")).toThrow();
    expect(parseAttestationMemo("hello")).toBeNull();
    expect(parseAttestationMemo(`pyre:burn:v1:${"zz".repeat(32)}`)).toBeNull();
    expect(parseAttestationMemo(`pyre:burn:v1:${"ab".repeat(31)}`)).toBeNull();
    expect(parseAttestationMemo(`pyre:burn:v2:${"ab".repeat(32)}`)?.version).toBe(2);
  });

  it("finds memos in parsed and raw instructions, top level and inner, ignoring other programs", () => {
    const memo = encodeAttestationMemo(DIGEST);
    const tx = parsedTx(
      [
        { programId: SystemProgram.programId, program: "system", parsed: { type: "transfer", info: {} } },
        { programId: MEMO_PROGRAM_ID, program: "spl-memo", parsed: memo },
      ],
      [{ programId: MEMO_PROGRAM_ID, accounts: [], data: bs58.encode(Buffer.from("inner memo", "utf8")) }],
    );
    expect(memosIn(tx)).toEqual([memo, "inner memo"]);
    expect(memosIn(parsedTx([]))).toEqual([]);
  });
});
