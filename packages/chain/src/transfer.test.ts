import { encodeAbiParameters, encodeEventTopics, getAddress, parseSignature, verifyTypedData, type Address, type Hash, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import type { PyrePublicClient } from "./chain.js";
import { deriveWallet } from "./keys.js";
import { erc20Abi } from "./pons/abi.js";
import { signUsdgAuthorization, usdgAddress, usdgAuthorizationTypedData, verifyErc20Transfer, verifyEthTransfer } from "./transfer.js";

const SEED = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const HASH: Hash = `0x${"11".repeat(32)}`;
const TREASURY: Address = "0x84F8E5a324466Deb7447048C014CF0245ce04afA";
const PAYER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

interface Chain {
  tx?: { from: Address; to: Address | null; value: bigint };
  receipt?: { status: "success" | "reverted"; blockNumber: bigint; from: Address; logs: Log[] };
  latest: bigint;
}

/** Just enough of a viem client for receipt verification; every field is what a node would return. */
function fakeClient(chain: Chain): PyrePublicClient {
  const client = {
    getTransaction: async () => {
      if (!chain.tx) throw new Error("TransactionNotFoundError");
      return chain.tx;
    },
    getTransactionReceipt: async () => {
      if (!chain.receipt) throw new Error("TransactionReceiptNotFoundError");
      return chain.receipt;
    },
    getBlockNumber: async () => chain.latest,
  };
  // Structural stand-in for the three methods the verifiers call.
  return client as unknown as PyrePublicClient;
}

function transferLog(token: Address, from: Address, to: Address, value: bigint): Log {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockNumber: 100n,
    transactionHash: HASH,
    transactionIndex: 0,
    blockHash: `0x${"22".repeat(32)}`,
    logIndex: 0,
    removed: false,
  };
}

describe("verifyEthTransfer", () => {
  const good: Chain = { tx: { from: PAYER, to: TREASURY, value: 2_000_000_000_000_000n }, receipt: { status: "success", blockNumber: 100n, from: PAYER, logs: [] }, latest: 100n };

  it("accepts a mined transfer that meets the minimum", async () => {
    const res = await verifyEthTransfer(HASH, { to: TREASURY, minWei: 2_000_000_000_000_000n, from: PAYER }, fakeClient(good));
    expect(res).toEqual({ ok: true, from: PAYER, wei: 2_000_000_000_000_000n });
  });

  it("is case-insensitive on addresses", async () => {
    const res = await verifyEthTransfer(HASH, { to: TREASURY.toLowerCase() as Address, minWei: 1n }, fakeClient(good));
    expect(res.ok).toBe(true);
  });

  it("rejects the wrong recipient, sender, amount, a revert and a missing tx", async () => {
    expect((await verifyEthTransfer(HASH, { to: PAYER, minWei: 1n }, fakeClient(good))).reason).toBe("wrong-recipient");
    expect((await verifyEthTransfer(HASH, { to: TREASURY, minWei: 1n, from: TREASURY }, fakeClient(good))).reason).toBe("wrong-sender");
    expect((await verifyEthTransfer(HASH, { to: TREASURY, minWei: 2_000_000_000_000_001n }, fakeClient(good))).reason).toBe("insufficient");
    const reverted = { ...good, receipt: { ...good.receipt!, status: "reverted" as const } };
    expect((await verifyEthTransfer(HASH, { to: TREASURY, minWei: 1n }, fakeClient(reverted))).reason).toBe("reverted");
    expect((await verifyEthTransfer(HASH, { to: TREASURY, minWei: 1n }, fakeClient({ latest: 100n }))).reason).toBe("not-found");
  });
});

describe("verifyErc20Transfer", () => {
  it("sums the token's Transfer logs to the recipient and reports the payer, not the relayer", async () => {
    const relayed: Chain = {
      receipt: {
        status: "success",
        blockNumber: 100n,
        from: TREASURY, // treasury relayed the EIP-3009 authorization
        logs: [
          transferLog(USDG, PAYER, TREASURY, 3_000_000n),
          transferLog(USDG, PAYER, TREASURY, 2_000_000n),
          transferLog("0x0000000000000000000000000000000000000abc", PAYER, TREASURY, 99_000_000n), // another token
          transferLog(USDG, TREASURY, PAYER, 1_000_000n), // opposite direction
        ],
      },
      latest: 101n,
    };
    const res = await verifyErc20Transfer(HASH, { token: USDG, to: TREASURY, minUnits: 5_000_000n }, fakeClient(relayed));
    expect(res).toEqual({ ok: true, from: PAYER, units: 5_000_000n });
    expect((await verifyErc20Transfer(HASH, { token: USDG, to: TREASURY, minUnits: 5_000_001n }, fakeClient(relayed))).reason).toBe("insufficient");
    // Only the one log in the opposite direction counts for PAYER as recipient.
    expect(await verifyErc20Transfer(HASH, { token: USDG, to: PAYER, minUnits: 1n }, fakeClient(relayed))).toEqual({ ok: true, from: TREASURY, units: 1_000_000n });
  });
});

describe("USDG EIP-3009 authorization", () => {
  it("signs typed data the USDG domain verifies for the custodial signer", async () => {
    const { account, address } = deriveWallet(3, SEED);
    const auth = await signUsdgAuthorization(account, { to: TREASURY, units: 1_500_000n, validBefore: 1_800_000_000n });
    expect(auth.from).toBe(address);
    expect(auth.to).toBe(getAddress(TREASURY));
    expect(auth.validAfter).toBe(0n);
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect([27, 28]).toContain(auth.v);
    expect(usdgAddress()).toBe(USDG);

    const typed = usdgAuthorizationTypedData({ from: auth.from, to: auth.to, value: auth.value, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce });
    const signature: Hex = `0x${auth.r.slice(2)}${auth.s.slice(2)}${auth.v.toString(16)}`;
    expect(parseSignature(signature).r).toBe(auth.r);
    expect(await verifyTypedData({ ...typed, address, signature })).toBe(true);
    expect(typed.domain).toEqual({ name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: USDG });
  });
});
