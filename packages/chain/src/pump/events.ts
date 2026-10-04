import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK, type BuyEventAmm, type CreateEventBc, type DistributeCreatorFeesEvent, type SellEventAmm, type TradeEventBc } from "@pump-fun/pump-sdk";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * pump and PumpSwap emit Anchor `#[event_cpi]` events: a self-CPI whose data is the 8-byte event
 * tag, the event discriminator, then the borsh event. They sit in the transaction's inner
 * instructions, so one `getTransaction` yields every fill with its post-trade reserves.
 */
const EVENT_CPI_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const TRADE_EVENT = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const CREATE_EVENT = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const AMM_BUY_EVENT = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const AMM_SELL_EVENT = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
/** Emitted by pump's `distribute_creator_fees` / `_v2` (also when the fees program CPIs into them): the total paid and the shareholder list it was split by. */
const DISTRIBUTE_CREATOR_FEES_EVENT = Buffer.from([165, 55, 129, 112, 4, 179, 202, 40]);

export type PumpEvent =
  | { kind: "trade"; event: TradeEventBc }
  | { kind: "create"; event: CreateEventBc }
  | { kind: "ammBuy"; event: BuyEventAmm }
  | { kind: "ammSell"; event: SellEventAmm };

/** Decodes one event-CPI instruction payload (the raw instruction data) for `program`, or null when it is not one. Exported for tests. */
export function decodeEventData(program: "pump" | "amm", data: Buffer): PumpEvent | null {
  if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_CPI_TAG)) return null;
  const disc = data.subarray(8, 16);
  const body = data.subarray(16);
  if (program === "pump") {
    if (disc.equals(TRADE_EVENT)) return { kind: "trade", event: PUMP_SDK.decodeTradeEventBc(body) };
    if (disc.equals(CREATE_EVENT)) return { kind: "create", event: PUMP_SDK.decodeCreateEventBc(body) };
    return null;
  }
  if (disc.equals(AMM_BUY_EVENT)) return { kind: "ammBuy", event: PUMP_SDK.decodeBuyEventAmm(body) };
  if (disc.equals(AMM_SELL_EVENT)) return { kind: "ammSell", event: PUMP_SDK.decodeSellEventAmm(body) };
  return null;
}

/** Raw event-CPI payloads (tag + discriminator + borsh) pump and PumpSwap emitted in a confirmed transaction, in execution order. */
function eventCpis(tx: VersionedTransactionResponse): Array<{ program: "pump" | "amm"; data: Buffer }> {
  if (!tx.meta) return [];
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  const out: Array<{ program: "pump" | "amm"; data: Buffer }> = [];
  for (const inner of tx.meta.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      const programId = keys.get(ix.programIdIndex);
      if (!programId) continue;
      const program = programId.equals(PUMP_PROGRAM_ID) ? "pump" : programId.equals(PUMP_AMM_PROGRAM_ID) ? "amm" : null;
      if (!program) continue;
      const data = Buffer.from(bs58.decode(ix.data));
      if (data.length >= 16 && data.subarray(0, 8).equals(EVENT_CPI_TAG)) out.push({ program, data });
    }
  }
  return out;
}

/** Every pump / PumpSwap event a confirmed transaction emitted, in execution order. */
export function decodePumpEvents(tx: VersionedTransactionResponse): PumpEvent[] {
  const events: PumpEvent[] = [];
  for (const { program, data } of eventCpis(tx)) {
    const decoded = decodeEventData(program, data);
    if (decoded) events.push(decoded);
  }
  return events;
}

/**
 * Every pump `DistributeCreatorFeesEvent` in a confirmed transaction. Only payloads carrying that
 * discriminator are decoded, so a scan over arbitrary transactions cannot trip on another event
 * whose on-chain layout the SDK decoder does not match.
 */
export function decodeDistributeEvents(tx: VersionedTransactionResponse): DistributeCreatorFeesEvent[] {
  return eventCpis(tx)
    .filter((e) => e.program === "pump" && e.data.subarray(8, 16).equals(DISTRIBUTE_CREATOR_FEES_EVENT))
    .map((e) => PUMP_SDK.decodeDistributeCreatorFeesEvent(e.data.subarray(16)));
}
