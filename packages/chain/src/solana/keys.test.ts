import { describe, expect, it } from "vitest";
import { deriveSolAppWallet, deriveSolWallet, isSolAddress, isSolSignature, solTreasury } from "./keys.js";

/*
 * Solana custodial derivation. Vectors were produced independently with `ed25519-hd-key`
 * (`derivePath(path, seedHex).key` → `Keypair.fromSeed`) on the same seeds, so a seed backup
 * restores every wallet whichever SLIP-0010 implementation is in use.
 */
const SEED = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const SLIP_SEED = "000102030405060708090a0b0c0d0e0f";

describe("solana key derivation", () => {
  it("matches the SLIP-0010 m/44'/501'/{i}'/0' reference vectors", () => {
    expect(deriveSolWallet(0, SEED).address).toBe("Eb42EjDFipJzBbPcqVd3NsZ8WFsZQb5yEzJHZ6y3n7j");
    expect(deriveSolWallet(1, SEED).address).toBe("Ge9qWzSr9ZgdF7LjFqjypEEgpwgZkeU48iHxVqUYGkG8");
    expect(deriveSolAppWallet(0, SEED).address).toBe("otCKk1NkLdsXxMFDWQhwNzrLdCTQ8B7vGTRoznWktWY");
    expect(solTreasury(SEED).address).toBe(deriveSolWallet(0, SEED).address);
    expect(deriveSolWallet(0, SLIP_SEED).address).toBe("39LoiUgZejnJYJVhvvAnxkMooM1uJ15Hkiz2iXTUwF65");
    expect(deriveSolWallet(1, SLIP_SEED).address).toBe("4KdsMWuf8XrX7ck5EupYrU488tyWwpFoTd3JEY4hwG4R");
    expect(deriveSolAppWallet(0, SLIP_SEED).address).toBe("noisdWFuDr2FSQhKvdaTAQ4JbSTbT3493QDDbV2wVXb");
  });

  it("signs for its own address and accepts a 0x-prefixed seed", () => {
    const w = deriveSolWallet(7, SEED);
    expect(w.keypair.publicKey.toBase58()).toBe(w.address);
    expect(deriveSolWallet(7, `0x${SEED}`).address).toBe(w.address);
  });

  it("keeps users and apps apart", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      seen.add(deriveSolWallet(i, SEED).address);
      seen.add(deriveSolAppWallet(i, SEED).address);
    }
    expect(seen.size).toBe(64);
  });

  it("rejects out-of-range indices and malformed seeds", () => {
    expect(() => deriveSolWallet(-1, SEED)).toThrow();
    expect(() => deriveSolWallet(1.5, SEED)).toThrow();
    expect(() => deriveSolWallet(0x80000000, SEED)).toThrow();
    expect(() => deriveSolAppWallet(0x7fffffff - 1_000_000 + 1, SEED)).toThrow();
    expect(() => deriveSolWallet(1, "not-hex")).toThrow();
  });
});

describe("solana address and signature checks", () => {
  it("accepts base58 32-byte keys and 64-byte signatures only", () => {
    expect(isSolAddress("Eb42EjDFipJzBbPcqVd3NsZ8WFsZQb5yEzJHZ6y3n7j")).toBe(true);
    expect(isSolAddress("So11111111111111111111111111111111111111112")).toBe(true);
    expect(isSolAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe(false);
    expect(isSolAddress("Eb42EjDFipJzBbPcqVd3NsZ8WFsZQb5yEzJHZ6y3n7")).toBe(false);
    expect(isSolAddress("")).toBe(false);
    expect(isSolSignature("38sUKnndu1SsjYHPKU3emjWkvpk3WMDMbt1WqCT7dz9RAy1GudoustsR2brKEDXfsSeuaoS2wCJokYjbWjS5Gbqh")).toBe(true);
    expect(isSolSignature("Eb42EjDFipJzBbPcqVd3NsZ8WFsZQb5yEzJHZ6y3n7j")).toBe(false);
    expect(isSolSignature(`0x${"ab".repeat(32)}`)).toBe(false);
  });
});
