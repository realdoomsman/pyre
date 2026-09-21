import { describe, expect, it } from "vitest";
import { deriveAppWallet, deriveWallet, treasury } from "./keys.js";

/*
 * Custodial key derivation. The invariant that must never break: a user wallet and an app wallet
 * at the same autoincrement index derive DIFFERENT keys (they live on different BIP-44 account
 * branches), and derivation matches the BIP-32/44 reference so a seed backup restores every wallet.
 */
const SEED = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

// BIP-39 seed of "test test test test test test test test test test test junk" (the Hardhat/Foundry
// default mnemonic). m/44'/60'/0'/0/0 and /1 are the well-known accounts #0 and #1.
const JUNK_SEED =
  "9dfc3c64c2f8bede1533b6a79f8570e5943e0b8fd1cf77107adf7b72cef42185d564a3aee24cab43f80e3c4538087d70fc824eabbad596a23c97b6ee8322ccc0";

describe("custodial key derivation", () => {
  it("matches the BIP-44 reference vectors", () => {
    expect(deriveWallet(0, JUNK_SEED).address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(deriveWallet(1, JUNK_SEED).address).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(treasury(JUNK_SEED).address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("is deterministic and the account signs for its address", async () => {
    const a = deriveWallet(7, SEED);
    expect(a.address).toBe(deriveWallet(7, SEED).address);
    expect(a.account.address).toBe(a.address);
    expect(a.account.type).toBe("local");
  });

  it("never collides between the user and app branches at the same index", () => {
    for (let i = 0; i < 32; i++) expect(deriveWallet(i, SEED).address).not.toBe(deriveAppWallet(i, SEED).address);
  });

  it("gives every index a distinct wallet on each branch", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      seen.add(deriveWallet(i, SEED).address);
      seen.add(deriveAppWallet(i, SEED).address);
    }
    expect(seen.size).toBe(128);
  });

  it("rejects an out-of-range index or a malformed seed", () => {
    expect(() => deriveWallet(-1, SEED)).toThrow();
    expect(() => deriveWallet(1.5, SEED)).toThrow();
    expect(() => deriveWallet(0x80000000, SEED)).toThrow();
    expect(() => deriveWallet(1, "not-hex")).toThrow();
    expect(() => deriveWallet(1, "abcd")).toThrow();
  });
});
