import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vitest";
import {
  REFUND_SNAPSHOT,
  allocateRefunds,
  microsToWei,
  refundEligibleWei,
  refundLinkMessage,
  refundRemainingWei,
  weiToMicros,
} from "./refund.js";

const ETH = 10n ** 18n;

describe("weiToMicros / microsToWei", () => {
  it("converts exactly at a fractional price", () => {
    expect(weiToMicros(ETH, 4123.45678912)).toBe(4_123_456_789n);
    expect(microsToWei(4_000_000_000n, 4000)).toBe(ETH);
  });
  it("round trip never exceeds the input", () => {
    for (const wei of [1n, 999_999n, 123_456_789_012_345n, 7n * ETH + 3n]) {
      expect(microsToWei(weiToMicros(wei, 3333.33), 3333.33) <= wei).toBe(true);
    }
  });
  it("rejects a non-positive price", () => {
    expect(() => weiToMicros(ETH, 0)).toThrow(RangeError);
  });
});

describe("allocateRefunds", () => {
  const price = 4000;

  it("splits pro-rata to remaining wei", () => {
    const { allocations, leftoverMicros } = allocateRefunds(
      3_000_000n,
      [
        { address: "a", remainingWei: 2n * ETH },
        { address: "b", remainingWei: ETH },
      ],
      price,
    );
    expect(allocations).toEqual([
      { address: "a", micros: 2_000_000n, wei: microsToWei(2_000_000n, price) },
      { address: "b", micros: 1_000_000n, wei: microsToWei(1_000_000n, price) },
    ]);
    expect(leftoverMicros).toBe(0n);
  });

  it("caps each holder at the value of what remains and returns the excess", () => {
    // a is owed $4 worth, b $8000 worth; a $20 pool would give a $0.00999.. pro-rata, b the rest capped at $8000.
    const small = 1_000_000_000_000_000n; // 0.001 ETH = $4
    const { allocations, leftoverMicros } = allocateRefunds(10_000_000_000n, [
      { address: "a", remainingWei: small },
      { address: "b", remainingWei: 2n * ETH },
    ], price);
    const a = allocations.find((x) => x.address === "a")!;
    const b = allocations.find((x) => x.address === "b")!;
    expect(b.micros).toBe(8_000_000_000n);
    expect(b.wei).toBe(2n * ETH);
    expect(a.micros).toBe(4_000_000n);
    expect(a.wei).toBe(small);
    expect(leftoverMicros).toBe(10_000_000_000n - 8_004_000_000n);
  });

  it("returns the whole pool when everyone is settled", () => {
    expect(allocateRefunds(5_000_000n, [{ address: "a", remainingWei: 0n }], price)).toEqual({ allocations: [], leftoverMicros: 5_000_000n });
    expect(allocateRefunds(5_000_000n, [], price)).toEqual({ allocations: [], leftoverMicros: 5_000_000n });
  });

  it("allocates nothing from an empty pool", () => {
    expect(allocateRefunds(0n, [{ address: "a", remainingWei: ETH }], price)).toEqual({ allocations: [], leftoverMicros: 0n });
  });

  it("never allocates more than the pool or settles more than remains", () => {
    const holders = Array.from({ length: 37 }, (_, i) => ({ address: `h${i}`, remainingWei: BigInt(i + 1) * 123_456_789_012_345n + 7n }));
    for (const pool of [1n, 999n, 1_234_567n, 10n ** 12n]) {
      const { allocations, leftoverMicros } = allocateRefunds(pool, holders, 2987.123);
      const spent = allocations.reduce((acc, a) => acc + a.micros, 0n);
      expect(spent + leftoverMicros).toBe(pool);
      expect(leftoverMicros >= 0n).toBe(true);
      for (const a of allocations) expect(a.wei <= holders.find((h) => h.address === a.address)!.remainingWei).toBe(true);
    }
  });

  it("settles dust worth under a micro-dollar without spending the pool", () => {
    const { allocations, leftoverMicros } = allocateRefunds(1_000_000n, [{ address: "a", remainingWei: 100n }], price);
    expect(allocations).toEqual([{ address: "a", micros: 0n, wei: 100n }]);
    expect(leftoverMicros).toBe(1_000_000n);
  });
});

describe("refundLinkMessage", () => {
  const params = {
    domain: "pyre.fun",
    uri: "https://pyre.fun",
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    solWallet: "So1ana1111111111111111111111111111111111111",
    nonce: "abcdefgh12345678",
    issuedAt: "2026-10-04T10:00:00.000Z",
  } as const;

  it("is an EIP-4361 message bound to the domain, chain and validity window, naming the Solana wallet and snapshot", () => {
    const msg = refundLinkMessage(params);
    expect(msg.split("\n")).toEqual([
      "pyre.fun wants you to sign in with your Ethereum account:",
      params.address,
      "",
      `Link Solana wallet ${params.solWallet} as the payout wallet for this address's Pyre PYRE refund (snapshot block ${REFUND_SNAPSHOT.block}). This does not move funds or cost gas.`,
      "",
      "URI: https://pyre.fun",
      "Version: 1",
      `Chain ID: ${REFUND_SNAPSHOT.chainId}`,
      "Nonce: abcdefgh12345678",
      "Issued At: 2026-10-04T10:00:00.000Z",
      "Expiration Time: 2026-10-04T10:05:00.000Z",
    ]);
  });

  it("parses back to the same fields and validates only inside its window on its own domain", () => {
    const fields = parseSiweMessage(refundLinkMessage(params));
    expect(fields).toMatchObject({ domain: "pyre.fun", address: params.address, chainId: REFUND_SNAPSHOT.chainId, nonce: params.nonce, uri: params.uri });
    const at = (iso: string) => validateSiweMessage({ message: fields, address: params.address, domain: "pyre.fun", nonce: params.nonce, time: new Date(iso) });
    expect(at("2026-10-04T10:04:59.000Z")).toBe(true);
    expect(at("2026-10-04T10:05:01.000Z")).toBe(false);
    expect(validateSiweMessage({ message: fields, domain: "pyre-refund.example", time: new Date("2026-10-04T10:01:00.000Z") })).toBe(false);
  });

  it("changes when the Solana wallet changes, so a signature cannot be moved to another payout wallet", () => {
    expect(refundLinkMessage({ ...params, solWallet: "Other1111111111111111111111111111111111111" })).not.toBe(refundLinkMessage(params));
  });
});

describe("refundEligibleWei", () => {
  it("keeps the full owed amount while the snapshot balance is still held", () => {
    expect(refundEligibleWei(5n * ETH, 1000n, 1000n)).toBe(5n * ETH);
  });

  it("never rises above owed even if min somehow exceeds the snapshot balance", () => {
    expect(refundEligibleWei(5n * ETH, 1000n, 4000n)).toBe(5n * ETH);
  });

  it("scales proportionally (floored) after a partial sell", () => {
    expect(refundEligibleWei(10n, 3n, 1n)).toBe(3n);
    expect(refundEligibleWei(4n * ETH, 1000n, 250n)).toBe(ETH);
  });

  it("is zero after selling out or with a zero snapshot balance", () => {
    expect(refundEligibleWei(4n * ETH, 1000n, 0n)).toBe(0n);
    expect(refundEligibleWei(4n * ETH, 0n, 0n)).toBe(0n);
  });
});

describe("refundRemainingWei", () => {
  it("is eligible minus settled, floored at zero once eligibility shrank below settled", () => {
    expect(refundRemainingWei(10n, 3n)).toBe(7n);
    expect(refundRemainingWei(2n, 3n)).toBe(0n);
  });
});
