import type { PublicKey } from "@solana/web3.js";
import { mapLimited } from "../candles.js";
import { SOLANA_COMMITMENT, connection } from "../solana/connection.js";
import { fetchTransaction } from "../solana/send.js";
import type { VenueTrade } from "../venue.js";
import { decodePumpEvents, type PumpEvent } from "./events.js";
import { bn, priceFromReserves, readPumpState } from "./read.js";

export interface PumpFill {
  side: "buy" | "sell";
  wallet: string;
  tokenUnits: bigint;
  /** Native paid (buy, fees included) or received (sell, net of fees). */
  quoteNative: bigint;
  priceNative: number;
}

/**
 * The fill an event describes for `mint`, or null when it is another coin's. Curve `TradeEvent`s
 * report the pre-fee quote with protocol and creator fees alongside (the buyback share is inside
 * the protocol fee); PumpSwap events report the user's total in/out directly.
 */
export function fillFromEvent(ev: PumpEvent, mint: PublicKey, pool: PublicKey): PumpFill | null {
  if (ev.kind === "trade" && ev.event.mint.equals(mint)) {
    const e = ev.event;
    const tokenUnits = bn(e.tokenAmount);
    const quote = bn(e.solAmount);
    const fees = bn(e.fee) + bn(e.creatorFee);
    const quoteNative = e.isBuy ? quote + fees : quote > fees ? quote - fees : 0n;
    return { side: e.isBuy ? "buy" : "sell", wallet: e.user.toBase58(), tokenUnits, quoteNative, priceNative: priceFromReserves(quoteNative, tokenUnits) };
  }
  if (ev.kind === "ammBuy" && ev.event.pool.equals(pool)) {
    const tokenUnits = bn(ev.event.baseAmountOut);
    const quoteNative = bn(ev.event.userQuoteAmountIn);
    return { side: "buy", wallet: ev.event.user.toBase58(), tokenUnits, quoteNative, priceNative: priceFromReserves(quoteNative, tokenUnits) };
  }
  if (ev.kind === "ammSell" && ev.event.pool.equals(pool)) {
    const tokenUnits = bn(ev.event.baseAmountIn);
    const quoteNative = bn(ev.event.userQuoteAmountOut);
    return { side: "sell", wallet: ev.event.user.toBase58(), tokenUnits, quoteNative, priceNative: priceFromReserves(quoteNative, tokenUnits) };
  }
  return null;
}

/**
 * Trade indexing by polling: every fill references the bonding curve (before graduation) or the
 * canonical pool (after), so `getSignaturesForAddress` on those two accounts from a slot cursor
 * lists every candidate transaction; the events inside give side, size and trader.
 */
const SIGNATURE_PAGE = 1000;
const MAX_PAGES = 20;
const TX_CONCURRENCY = 4;

/** More than `MAX_PAGES × SIGNATURE_PAGE` signatures sit between the cursor and now; index a narrower window. */
export class PumpTradeWindowTooDeepError extends Error {
  constructor(
    readonly address: string,
    readonly fromSlot: number,
  ) {
    super(`pump trades: more than ${MAX_PAGES * SIGNATURE_PAGE} signatures on ${address} since slot ${fromSlot}; narrow the window`);
    this.name = "PumpTradeWindowTooDeepError";
  }
}

interface SignatureRef {
  signature: string;
  slot: number;
  blockTime: number | null;
}

/** Successful signatures touching `address` with `fromSlot ≤ slot ≤ toSlot`, newest first as the RPC returns them. */
async function signaturesInRange(address: PublicKey, fromSlot: number, toSlot: number): Promise<SignatureRef[]> {
  const conn = connection();
  const out: SignatureRef[] = [];
  let before: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new PumpTradeWindowTooDeepError(address.toBase58(), fromSlot);
    const batch = await conn.getSignaturesForAddress(address, { limit: SIGNATURE_PAGE, before }, SOLANA_COMMITMENT);
    if (batch.length === 0) break;
    for (const s of batch) {
      if (s.err || s.slot > toSlot) continue;
      if (s.slot < fromSlot) return out;
      out.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null });
    }
    if (batch.length < SIGNATURE_PAGE) break;
    before = batch[batch.length - 1]!.signature;
  }
  return out;
}

/**
 * Fills for `mint` in `[fromSlot, toSlot]`, ascending by slot. Curve fills come from `TradeEvent`
 * (quote gross of fees on buys, net on sells, like PONS); pool fills from PumpSwap `BuyEvent` /
 * `SellEvent` (`userQuoteAmountIn` / `userQuoteAmountOut`).
 */
export async function pumpTrades(mint: string, fromSlot: number, toSlot: number): Promise<VenueTrade[]> {
  if (fromSlot > toSlot) return [];
  const state = await readPumpState(mint);
  if (!state.bondingCurve) return [];
  const [curveSigs, poolSigs] = await Promise.all([signaturesInRange(state.curve, fromSlot, toSlot), signaturesInRange(state.pool, fromSlot, toSlot)]);
  const seen: Record<string, true> = {};
  const refs = [...curveSigs, ...poolSigs].filter((r) => (seen[r.signature] ? false : (seen[r.signature] = true)));
  const mintKey = state.mint;
  const poolKey = state.pool;
  const trades = await mapLimited(refs, TX_CONCURRENCY, async (ref): Promise<VenueTrade[]> => {
    const tx = await fetchTransaction(ref.signature);
    if (tx.meta?.err) return [];
    const ts = tx.blockTime ?? ref.blockTime ?? 0;
    const out: VenueTrade[] = [];
    for (const ev of decodePumpEvents(tx)) {
      const fill = fillFromEvent(ev, mintKey, poolKey);
      if (fill) out.push({ hash: ref.signature, block: ref.slot, ts, ...fill });
    }
    return out;
  });
  return trades.flat().sort((a, b) => a.block - b.block || a.ts - b.ts);
}

export async function currentSlot(): Promise<number> {
  return connection().getSlot(SOLANA_COMMITMENT);
}
