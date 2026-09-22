import { unpackAccount } from "@solana/spl-token";
import { SOLANA_COMMITMENT, connection } from "../solana/connection.js";
import type { VenueHolder } from "../venue.js";
import { readPumpState } from "./read.js";

/**
 * Top holders from `getTokenLargestAccounts` (the RPC caps it at 20). The result lists token
 * accounts, so owners are resolved with one more batch read; the bonding curve's and the canonical
 * pool's accounts are tagged `liquidity` like the PONS curve / PoolManager rows.
 */
export async function pumpHolders(mint: string, limit: number): Promise<VenueHolder[]> {
  const conn = connection();
  const state = await readPumpState(mint);
  if (!state.tokenProgram || state.supply === null) return [];
  const largest = (await conn.getTokenLargestAccounts(state.mint, SOLANA_COMMITMENT)).value.filter((a) => BigInt(a.amount) > 0n).slice(0, Math.max(0, limit));
  if (largest.length === 0) return [];
  const infos = await conn.getMultipleAccountsInfo(
    largest.map((a) => a.address),
    SOLANA_COMMITMENT,
  );
  const supply = state.supply;
  const holders: VenueHolder[] = [];
  largest.forEach((a, i) => {
    const info = infos[i];
    if (!info) return;
    const owner = unpackAccount(a.address, info, info.owner).owner;
    const units = BigInt(a.amount);
    const system = owner.equals(state.curve) || owner.equals(state.pool) ? "liquidity" : null;
    holders.push({ address: owner.toBase58(), units, share: supply > 0n ? Number(units) / Number(supply) : 0, system });
  });
  return holders;
}
