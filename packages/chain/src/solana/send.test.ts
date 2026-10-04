import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionExpiredBlockheightExceededError, VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaTransactionUnconfirmedError, sendInstructions, sendSerializedInstructions } from "./send.js";

/**
 * A transfer whose blockhash expired is re-signed only when the first one provably cannot land
 * (finalized block height past its lastValidBlockHeight and no status even with history search);
 * anything less is reported unconfirmed with that height so the caller can resolve it later.
 */

const conn = {
  getRecentPrioritizationFees: vi.fn(async () => []),
  getLatestBlockhash: vi.fn(),
  sendRawTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
  getSignatureStatuses: vi.fn(),
  getBlockHeight: vi.fn(),
  getTransaction: vi.fn(),
  getAddressLookupTable: vi.fn(),
};

vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));
vi.mock("./connection.js", () => ({ connection: () => conn, SOLANA_COMMITMENT: "confirmed", MAX_TX_VERSION: 1 }));
vi.mock("./fees.js", () => ({ computeUnitPrice: async () => 1 }));
vi.mock("../sendLock.js", () => ({ withSendLock: (_key: string, fn: () => Promise<unknown>) => fn() }));

const payer = Keypair.generate();
const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
const send = () => sendInstructions(payer, [ix], { computeUnits: 1_000 });
const status = (confirmationStatus: string, err: unknown = null) => ({ value: [{ slot: 1, confirmations: 0, err, confirmationStatus }] });
const unknown = { value: [null] };

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  conn.getLatestBlockhash.mockImplementation(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 + 10 * n++ }));
  let s = 0;
  conn.sendRawTransaction.mockImplementation(async () => `sig${++s}`);
  conn.confirmTransaction.mockImplementation(async ({ signature }: { signature: string }) => {
    throw new TransactionExpiredBlockheightExceededError(signature);
  });
  conn.getTransaction.mockImplementation(async () => ({ slot: 7, meta: { err: null } }));
});

describe("sendInstructions after blockhash expiry", () => {
  it("waits out a processed status instead of re-signing, and returns the first signature once it confirms", async () => {
    conn.getSignatureStatuses.mockResolvedValueOnce(status("processed")).mockResolvedValueOnce(status("confirmed"));
    await expect(send()).resolves.toMatchObject({ signature: "sig1", slot: 7 });
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(conn.getSignatureStatuses).toHaveBeenCalledWith(["sig1"], { searchTransactionHistory: true });
  });

  it("never re-signs while the finalized height has not passed lastValidBlockHeight", async () => {
    conn.getSignatureStatuses.mockResolvedValue(unknown);
    conn.getBlockHeight.mockResolvedValue(100);
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SolanaTransactionUnconfirmedError);
    expect(err).toMatchObject({ signature: "sig1", lastValidBlockHeight: 100 });
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(conn.getBlockHeight).toHaveBeenCalledWith("finalized");
  });

  it("re-signs once the first blockhash is provably expired", async () => {
    conn.getSignatureStatuses.mockResolvedValue(unknown);
    conn.getBlockHeight.mockResolvedValue(101);
    conn.confirmTransaction
      .mockImplementationOnce(async ({ signature }: { signature: string }) => {
        throw new TransactionExpiredBlockheightExceededError(signature);
      })
      .mockImplementationOnce(async () => ({ value: { err: null } }));
    await expect(send()).resolves.toMatchObject({ signature: "sig2" });
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not re-sign when the status appears between the height check and the re-read", async () => {
    conn.getSignatureStatuses.mockResolvedValueOnce(unknown).mockResolvedValueOnce(status("processed")).mockResolvedValueOnce(status("finalized"));
    conn.getBlockHeight.mockResolvedValue(101);
    await expect(send()).resolves.toMatchObject({ signature: "sig1" });
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("carries lastValidBlockHeight on a confirmation transport error", async () => {
    conn.confirmTransaction.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(send()).rejects.toMatchObject({ signature: "sig1", lastValidBlockHeight: 100 });
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("onBroadcast", () => {
  it("reports each broadcast signature before confirmation, including the re-signed one", async () => {
    conn.getSignatureStatuses.mockResolvedValue(unknown);
    conn.getBlockHeight.mockResolvedValue(101);
    const order: string[] = [];
    conn.confirmTransaction
      .mockImplementationOnce(async ({ signature }: { signature: string }) => {
        order.push(`confirm ${signature}`);
        throw new TransactionExpiredBlockheightExceededError(signature);
      })
      .mockImplementationOnce(async ({ signature }: { signature: string }) => {
        order.push(`confirm ${signature}`);
        return { value: { err: null } };
      });
    await sendInstructions(payer, [ix], { computeUnits: 1_000, onBroadcast: (signature) => void order.push(`broadcast ${signature}`) });
    expect(order).toEqual(["broadcast sig1", "confirm sig1", "broadcast sig2", "confirm sig2"]);
  });
});

describe("sendSerializedInstructions", () => {
  const serialized = (signer: PublicKey) => ({
    programId: SystemProgram.programId.toBase58(),
    keys: [
      { pubkey: signer.toBase58(), isSigner: true, isWritable: true },
      { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true },
    ],
    data: "02000000d654750700000000",
  });

  it("compiles the decoded instructions against the resolved lookup tables", async () => {
    const extra = Keypair.generate().publicKey;
    const lutKey = Keypair.generate().publicKey;
    const ixs = [serialized(payer.publicKey)];
    const table = new AddressLookupTableAccount({ key: lutKey, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [new PublicKey(ixs[0]!.keys[1]!.pubkey), extra] } });
    conn.getAddressLookupTable.mockResolvedValue({ value: table });
    conn.confirmTransaction.mockResolvedValue({ value: { err: null } });
    await expect(sendSerializedInstructions(payer, ixs, { computeUnits: 1_000, lookupTables: [lutKey.toBase58()] })).resolves.toMatchObject({ signature: "sig1" });
    expect(conn.getAddressLookupTable).toHaveBeenCalledWith(lutKey, { commitment: "confirmed" });
    const sent = VersionedTransaction.deserialize(conn.sendRawTransaction.mock.calls[0]![0] as Uint8Array);
    expect(sent.message.addressTableLookups).toEqual([{ accountKey: lutKey, writableIndexes: [0], readonlyIndexes: [] }]);
    const deposit = sent.message.compiledInstructions.at(-1)!;
    expect(Buffer.from(deposit.data).toString("hex")).toBe("02000000d654750700000000");
  });

  it("refuses, before anything is signed, an instruction that needs another signer or a missing lookup table", async () => {
    await expect(sendSerializedInstructions(payer, [serialized(Keypair.generate().publicKey)], { computeUnits: 1_000 })).rejects.toThrow(/needs a signature from/);
    conn.getAddressLookupTable.mockResolvedValue({ value: null });
    await expect(sendSerializedInstructions(payer, [serialized(payer.publicKey)], { computeUnits: 1_000, lookupTables: [Keypair.generate().publicKey.toBase58()] })).rejects.toThrow(/lookup table .* not found/);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });
});
