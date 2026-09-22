import { describe, expect, it } from "vitest";
import { PRIORITY_FEE_CAP_MICROLAMPORTS, PRIORITY_FEE_FLOOR_MICROLAMPORTS, clampComputeUnitPrice, priorityFeeLamports } from "./fees.js";

describe("compute-unit price", () => {
  it("takes the median of the observed fees within the floor and cap", () => {
    expect(clampComputeUnitPrice([50_000, 400_000, 150_000])).toBe(150_000);
    expect(clampComputeUnitPrice([100_000, 300_000, 200_000, 400_000])).toBe(250_000);
    expect(clampComputeUnitPrice([0, 0, 1_000])).toBe(PRIORITY_FEE_FLOOR_MICROLAMPORTS);
    expect(clampComputeUnitPrice([])).toBe(PRIORITY_FEE_FLOOR_MICROLAMPORTS);
    expect(clampComputeUnitPrice([9_000_000, 8_000_000, 7_000_000])).toBe(PRIORITY_FEE_CAP_MICROLAMPORTS);
  });

  it("prices a budget in lamports with the base fee per signature", () => {
    expect(priorityFeeLamports(270_000, 100_000, 2)).toBe(27_000n + 10_000n);
    expect(priorityFeeLamports(1, 1)).toBe(1n + 5_000n);
  });
});
