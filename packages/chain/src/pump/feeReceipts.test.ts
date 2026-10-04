import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { Keypair, MessageAccountKeys, PublicKey, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pyreSolFeeReceipts } from "./feeReceipts.js";

const { getSignaturesForAddress, fetchTransaction } = vi.hoisted(() => ({ getSignaturesForAddress: vi.fn(), fetchTransaction: vi.fn() }));
vi.mock("../solana/connection.js", async (importOriginal) => ({ ...((await importOriginal()) as object), connection: () => ({ getSignaturesForAddress }) }));
vi.mock("../solana/send.js", async (importOriginal) => ({ ...((await importOriginal()) as object), fetchTransaction }));

/*
 * Real `DistributeCreatorFeesEvent` event-CPI payload from mainnet tx
 * ymj2r1exqxMnN33TQvyzdVybRHZE8DLrgjSBKPXpwcDGPLF6YURRcvh8aAvbofKphDSp2RGpVEQ6LJrJ3EwXU5h (slot 451443594):
 * mint 9EQSeWY7…pump, 338 707 792 lamports split 8000 / 1000 / 1000 bps; on chain the first
 * shareholder received 270 966 234 (floor + the 1-lamport remainder), the other two 33 870 779 each.
 */
const DISTRIBUTE_EVENT =
  "n5Uk7MBThksUEcyE2uW17NGn2cPbAQvPSc75yWBwYpdZUk66C7JMKJcaRccjM7ScvXqVgZWJKVubojqg3884daHtQBjiCqKPGKDoJL7gXE4rV6iLMFTMRrs74G2sT3EirbXzpfxncjJXsoeh8QuhNH1ceoaWWyVw7EgnMDi7htDh46zMjWkj7pgovYMMxo651dtgWUVzY9DYL3mDarVn3YqbLghJshhHYY7GockctRVfoUc3Z6aQx22Ki4NgTheKv7sh1cPcYQW8Ad3mE9Aphewh1L2HPDEvBQc2Xf7f6dw3Gc1i6xA6VtDMP9QP9pkHviA9bPniiUThy1BcKpCktR9FuMpMLSPTfPxFZ23e641g4XQqQaYg63oiwfDEw5Z63JunYJ7rscMvUmJeTMxjEas";
const MINT = "9EQSeWY7pDB7MYoSFr8QJ19onGS1ehDmLbSGT2b3pump";
const FIRST = new PublicKey("CHYrs2DHv8euXnovPiL9kVnPWoi9c5WxY7ZoPuoC6pCH"); // 8000 bps
const SECOND = new PublicKey("DCQ7faYsucjQ4CqRte7GJCdb9k1QWVMZC5wTYkGY8dx3"); // 1000 bps
const THIRD = new PublicKey("97PmrJbEGpNde5HgGsD8xWbvpfTij4Ja21eNf36sYq6V"); // 1000 bps
const BOT = Keypair.generate().publicKey;
const FEE = 13_766;

/** A confirmed transaction paying `gains` (lamports received per account, fee not included) with the given pump event CPIs. */
function tx(payer: PublicKey, gains: Map<PublicKey, number>, events: string[], err: unknown = null): VersionedTransactionResponse {
  const keys = [payer, ...[...gains.keys()].filter((k) => !k.equals(payer)), PUMP_PROGRAM_ID];
  const pre = keys.map(() => 10_000_000_000);
  const post = keys.map((k, i) => pre[i]! + (gains.get(k) ?? 0) - (i === 0 ? FEE : 0));
  const pumpIndex = keys.length - 1;
  return {
    slot: 451_443_594,
    blockTime: 1_790_631_905,
    version: 0,
    transaction: { message: { getAccountKeys: () => new MessageAccountKeys(keys) }, signatures: [] },
    meta: { err, fee: FEE, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [{ index: 0, instructions: events.map((data) => ({ programIdIndex: pumpIndex, accounts: [], data })) }] },
  } as unknown as VersionedTransactionResponse;
}
const realPayouts = (): Map<PublicKey, number> =>
  new Map([
    [FIRST, 270_966_234],
    [SECOND, 33_870_779],
    [THIRD, 33_870_779],
  ]);
const sig = (signature: string, err: unknown = null): ConfirmedSignatureInfo => ({ signature, slot: 451_443_594, blockTime: 1_790_631_905, err, memo: null });

let txs: Map<string, VersionedTransactionResponse>;
beforeEach(() => {
  vi.clearAllMocks();
  txs = new Map();
  fetchTransaction.mockImplementation(async (s: string) => txs.get(s)!);
});

describe("pyreSolFeeReceipts", () => {
  it("credits a distribution someone else sent with the treasury's own split, matching its balance change", async () => {
    txs.set("botSig", tx(BOT, realPayouts(), [DISTRIBUTE_EVENT]));
    getSignaturesForAddress.mockResolvedValueOnce([sig("botSig")]);
    const scan = await pyreSolFeeReceipts(MINT, SECOND.toBase58());
    expect(scan).toEqual({
      receipts: [{ signature: "botSig", slot: 451_443_594, blockTime: 1_790_631_905, treasuryLamports: 33_870_779n, eventLamports: 33_870_779n, balanceLamports: 33_870_779n }],
      head: "botSig",
      oldest: "botSig",
      reachedUntil: true,
    });
    expect(getSignaturesForAddress).toHaveBeenCalledWith(SECOND, { limit: 100, before: undefined, until: undefined }, "finalized");
  });

  it("adds the fee back when the treasury sent the distribution itself", async () => {
    txs.set("ownSig", tx(THIRD, realPayouts(), [DISTRIBUTE_EVENT]));
    getSignaturesForAddress.mockResolvedValueOnce([sig("ownSig")]);
    const [r] = (await pyreSolFeeReceipts(MINT, THIRD.toBase58())).receipts;
    expect(r).toMatchObject({ treasuryLamports: 33_870_779n, eventLamports: 33_870_779n, balanceLamports: 33_870_779n });
  });

  it("gives the first shareholder the rounding remainder, as pump pays it", async () => {
    txs.set("botSig", tx(BOT, realPayouts(), [DISTRIBUTE_EVENT]));
    getSignaturesForAddress.mockResolvedValueOnce([sig("botSig")]);
    const [r] = (await pyreSolFeeReceipts(MINT, FIRST.toBase58())).receipts;
    expect(r).toMatchObject({ treasuryLamports: 270_966_234n, eventLamports: 270_966_234n });
  });

  it("never credits more than the treasury's balance actually gained", async () => {
    const spent = realPayouts();
    spent.set(SECOND, 33_870_779 - 5_000_000); // the treasury also paid something out in that transaction
    txs.set("mixedSig", tx(BOT, spent, [DISTRIBUTE_EVENT]));
    getSignaturesForAddress.mockResolvedValueOnce([sig("mixedSig")]);
    const [r] = (await pyreSolFeeReceipts(MINT, SECOND.toBase58())).receipts;
    expect(r).toMatchObject({ treasuryLamports: 28_870_779n, eventLamports: 33_870_779n, balanceLamports: 28_870_779n });
  });

  it("ignores failed transactions, other coins' distributions and transactions without one; reports 0 when the treasury is not a shareholder", async () => {
    txs.set("failedTx", tx(BOT, new Map(), [DISTRIBUTE_EVENT], { InstructionError: [0, { Custom: 6000 }] }));
    txs.set("payout", tx(SECOND, new Map([[BOT, 1_000_000]]), []));
    txs.set("botSig", tx(BOT, realPayouts(), [DISTRIBUTE_EVENT]));
    getSignaturesForAddress.mockResolvedValue([sig("listedFailed", { InstructionError: [0, "Custom"] }), sig("failedTx"), sig("payout"), sig("botSig")]);

    const outsider = Keypair.generate().publicKey.toBase58();
    expect((await pyreSolFeeReceipts(MINT, outsider)).receipts).toEqual([expect.objectContaining({ signature: "botSig", treasuryLamports: 0n, eventLamports: 0n })]);
    expect(fetchTransaction).not.toHaveBeenCalledWith("listedFailed");

    const otherMint = Keypair.generate().publicKey.toBase58();
    const scan = await pyreSolFeeReceipts(otherMint, SECOND.toBase58());
    expect(scan.receipts).toEqual([]);
    expect(scan).toMatchObject({ head: "listedFailed", oldest: "botSig", reachedUntil: true });
  });

  it("pages down to the cursor, and stops at maxPages with where to continue", async () => {
    const page = (from: number) => Array.from({ length: 100 }, (_, i) => sig(`s${from - i}`));
    const empty = tx(BOT, new Map(), []);
    fetchTransaction.mockResolvedValue(empty);
    getSignaturesForAddress.mockResolvedValueOnce(page(300)).mockResolvedValueOnce(page(200));
    const capped = await pyreSolFeeReceipts(MINT, SECOND.toBase58(), "s0", { maxPages: 2 });
    expect(capped).toMatchObject({ head: "s300", oldest: "s101", reachedUntil: false });
    expect(getSignaturesForAddress).toHaveBeenNthCalledWith(2, SECOND, { limit: 100, before: "s201", until: "s0" }, "finalized");

    getSignaturesForAddress.mockResolvedValueOnce(page(100)).mockResolvedValueOnce([]);
    const rest = await pyreSolFeeReceipts(MINT, SECOND.toBase58(), "s0", { before: "s101", maxPages: 2 });
    expect(rest).toMatchObject({ head: "s100", oldest: "s1", reachedUntil: true });
    expect(getSignaturesForAddress).toHaveBeenNthCalledWith(3, SECOND, { limit: 100, before: "s101", until: "s0" }, "finalized");
  });
});
