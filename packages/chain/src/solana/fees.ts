import type { Connection, PublicKey } from "@solana/web3.js";

/**
 * Priority fees. pump's own frontend floors the compute-unit price at 100k µlamports and caps it
 * at 5M; between those the median of the recent prioritisation fees for the accounts we write is
 * enough to land within a few slots without overpaying in a quiet market.
 */
export const PRIORITY_FEE_FLOOR_MICROLAMPORTS = 100_000;
export const PRIORITY_FEE_CAP_MICROLAMPORTS = 5_000_000;

/** Compute-unit limits per instruction family: pump's frontend defaults, with headroom for the ATA/volume-accumulator creates a first trade adds. */
export const COMPUTE_UNITS = { create: 270_000, curveSwap: 150_000, ammSwap: 200_000, collectFees: 200_000, burn: 60_000, transfer: 20_000 } as const;

/** Pure: median of the observed fees, clamped to [floor, cap]. Exported for tests. */
export function clampComputeUnitPrice(observed: number[]): number {
  const sorted = observed.filter((f) => Number.isFinite(f) && f >= 0).sort((a, b) => a - b);
  const median = sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : Math.floor((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2);
  return Math.min(PRIORITY_FEE_CAP_MICROLAMPORTS, Math.max(PRIORITY_FEE_FLOOR_MICROLAMPORTS, median));
}

/** Micro-lamports per compute unit for a transaction touching `writable`. Never below the floor; falls back to the floor when the RPC cannot answer. */
export async function computeUnitPrice(connection: Connection, writable: PublicKey[]): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 128) });
    return clampComputeUnitPrice(fees.map((f) => f.prioritizationFee));
  } catch {
    return PRIORITY_FEE_FLOOR_MICROLAMPORTS;
  }
}

/** Lamports a priority fee costs at `units` × `microLamports`, plus the 5k base fee per signature. */
export const priorityFeeLamports = (units: number, microLamports: number, signatures = 1): bigint => BigInt(Math.ceil((units * microLamports) / 1_000_000)) + 5_000n * BigInt(signatures);
