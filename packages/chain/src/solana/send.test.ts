import { Keypair, SystemProgram, TransactionExpiredBlockheightExceededError } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaTransactionUnconfirmedError, sendInstructions } from "./send.js";

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
