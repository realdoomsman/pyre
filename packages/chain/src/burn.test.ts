import { describe, expect, it } from "vitest";
import { ATTESTATION_PREFIX, attestationHash, encodeAttestation, parseAttestation } from "./burn.js";

describe("burn attestation", () => {
  it("hashes revenue ids order-independently as 0x-prefixed sha256", () => {
    const h = attestationHash(["b", "a", "c"]);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h).toBe(attestationHash(["c", "a", "b"]));
    expect(h).not.toBe(attestationHash(["a", "b"]));
  });

  it("round-trips through calldata", () => {
    const h = attestationHash(["rev_1"]);
    const data = encodeAttestation(h);
    expect(data.startsWith(ATTESTATION_PREFIX)).toBe(true);
    expect(data.length).toBe(ATTESTATION_PREFIX.length + 64);
    expect(parseAttestation(data)).toBe(h);
    expect(parseAttestation(data.toUpperCase().replace("0X", "0x"))).toBe(h);
  });

  it("rejects calldata that is not a Pyre attestation", () => {
    expect(parseAttestation("0x")).toBeNull();
    expect(parseAttestation(`0x5059524502${"ab".repeat(32)}`)).toBeNull();
    expect(parseAttestation(`${ATTESTATION_PREFIX}${"ab".repeat(31)}`)).toBeNull();
    expect(parseAttestation(`${ATTESTATION_PREFIX}${"zz".repeat(32)}`)).toBeNull();
    expect(() => encodeAttestation("0x1234")).toThrow();
  });
});
