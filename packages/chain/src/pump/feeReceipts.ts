import type { DistributeCreatorFeesEvent } from "@pump-fun/pump-sdk";
import type { ConfirmedSignatureInfo, Finality, PublicKey } from "@solana/web3.js";
import { mapLimited } from "../candles.js";
import { connection } from "../solana/connection.js";
import { pubkey } from "../solana/keys.js";
import { fetchTransaction, lamportDelta } from "../solana/send.js";
import { decodeDistributeEvents } from "./events.js";
import { bn } from "./read.js";

/**
 * `distribute_creator_fees(_v2)` is permissionless: pump.fun's site, a bot or any shareholder may
 * pay a fee-sharing coin's shareholders, so the treasury's share often arrives in a transaction
 * the runner never sent. Every lamport the treasury receives is in a transaction that lists the
 * treasury, so its own signature history is the complete candidate set. (The coin's sharing
 * config is no narrower: every buy and sell reads it for the fee tiers, so its history is mostly
 * trades.) Only finalized history is read, so a signature never appears behind the cursor later.
 */
const RECEIPT_PAGE = 100;
const RECEIPT_MAX_PAGES = 10;
const RECEIPT_TX_CONCURRENCY = 4;
const RECEIPT_COMMITMENT: Finality = "finalized";

export interface PyreSolFeeReceipt {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** What the treasury received from the coin's distribution(s) in this transaction: `eventLamports`, never more than `balanceLamports`. */
  treasuryLamports: bigint;
  /** The treasury's split of every `DistributeCreatorFeesEvent` for the coin in the transaction. */
  eventLamports: bigint;
  /** The treasury's lamport change in the transaction (the fee added back when it paid). */
  balanceLamports: bigint;
}

export interface PyreSolFeeReceiptScan {
  /** Successful transactions that distributed the coin's fees, newest first; `treasuryLamports` is 0n when the treasury got nothing from them. */
  receipts: PyreSolFeeReceipt[];
  /** Newest signature listed (null: nothing newer than `untilSignature`). */
  head: string | null;
  /** Oldest signature listed; the `before` that continues a scan that stopped at `maxPages`. */
  oldest: string | null;
  /** True when the listing reached `untilSignature` (or the start of the treasury's history); false when it stopped at `maxPages`. */
  reachedUntil: boolean;
}

/**
 * The treasury's share of one event. pump splits `distributed` by each shareholder's bps (floor)
 * and pays the rounding remainder to the first shareholder (seen on mainnet: 338 707 792 lamports
 * at 8000/1000/1000 bps paid 270 966 234 / 33 870 779 / 33 870 779).
 */
function treasuryShareOf(event: DistributeCreatorFeesEvent, treasury: PublicKey): bigint {
  const total = bn(event.distributed);
  let paid = 0n;
  let mine = 0n;
  for (const s of event.shareholders) {
    const part = (total * BigInt(s.shareBps)) / 10_000n;
    paid += part;
    if (s.address.equals(treasury)) mine += part;
  }
  if (event.shareholders[0]?.address.equals(treasury) && total > paid) mine += total - paid;
  return mine;
}

/**
 * Every finalized, successful transaction since `untilSignature` that distributed `mint`'s creator
 * fees, with what `treasury` received in it — whoever sent it. Lists the treasury's signatures
 * newest → oldest from `before` (default: the newest) down to `untilSignature`, at most
 * `maxPages` pages of 100; failed signatures are skipped without fetching. The amount comes from
 * pump's own event (an authenticated event CPI: only pump can sign as its event authority), capped
 * by the treasury's actual balance change so a transaction where the treasury also spent can
 * never over-credit. Transactions of every live message version are read (web3.js parses v0 and v1).
 */
export async function pyreSolFeeReceipts(mint: string, treasury: string, untilSignature?: string, opts: { before?: string; maxPages?: number } = {}): Promise<PyreSolFeeReceiptScan> {
  const conn = connection();
  const mintKey = pubkey(mint);
  const treasuryKey = pubkey(treasury);
  const maxPages = opts.maxPages ?? RECEIPT_MAX_PAGES;
  const refs: ConfirmedSignatureInfo[] = [];
  let before = opts.before;
  let reachedUntil = false;
  for (let page = 0; page < maxPages; page++) {
    const batch = await conn.getSignaturesForAddress(treasuryKey, { limit: RECEIPT_PAGE, before, until: untilSignature }, RECEIPT_COMMITMENT);
    refs.push(...batch);
    if (batch.length < RECEIPT_PAGE) {
      reachedUntil = true;
      break;
    }
    before = batch[batch.length - 1]!.signature;
  }
  const found = await mapLimited(
    refs.filter((r) => !r.err),
    RECEIPT_TX_CONCURRENCY,
    async (ref): Promise<PyreSolFeeReceipt | null> => {
      const tx = await fetchTransaction(ref.signature);
      if (!tx.meta || tx.meta.err) return null;
      const events = decodeDistributeEvents(tx).filter((e) => e.mint.equals(mintKey));
      if (events.length === 0) return null;
      const eventLamports = events.reduce((sum, e) => sum + treasuryShareOf(e, treasuryKey), 0n);
      const balanceLamports = lamportDelta(tx, treasuryKey);
      const treasuryLamports = eventLamports < balanceLamports ? eventLamports : balanceLamports > 0n ? balanceLamports : 0n;
      return { signature: ref.signature, slot: ref.slot, blockTime: tx.blockTime ?? ref.blockTime ?? null, treasuryLamports, eventLamports, balanceLamports };
    },
  );
  return {
    receipts: found.filter((r): r is PyreSolFeeReceipt => r !== null),
    head: refs[0]?.signature ?? null,
    oldest: refs[refs.length - 1]?.signature ?? null,
    reachedUntil,
  };
}
