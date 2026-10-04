/**
 * PYRE holder refund program: holders of the Robinhood Chain PYRE at REFUND_SNAPSHOT.block are
 * refunded the ETH they put in (capped at that amount), paid in SOL. The `REFUND` ledger pool is
 * funded by a share of the Solana PYRE coin's creator fees and by the 25% PYRE leg of every legacy
 * Robinhood Chain coin's creator fees, each only while a holder is still owed. Pure, browser-safe
 * arithmetic and wire types shared by the API, the runner and the web app.
 */

import { createSiweMessage } from "viem/siwe";

export const REFUND_SNAPSHOT = {
  chainId: 4663,
  token: "0xc8488bE2e4f430420A364E64f4D8af428b74D903",
  block: 79819827,
  blockHash: "0x141e47824b2a808e47e0e4d5262f7c7b3eb0b4f77c6d0b1113b7aa11874df0d8",
  blockTime: "2026-10-04T09:12:28Z",
} as const;
/** Share of the Solana PYRE coin's creator fees credited to the REFUND ledger account (legacy Robinhood Chain coins add their 25% PYRE leg, `FEE_SPLIT_BPS.PYRE_TOKEN`). */
export const REFUND_FEE_BPS = 2500;
export const REFUND_LEDGER_ACCOUNT = "REFUND";
/** $1; also above the Solana rent-exempt minimum for a fresh account. */
export const REFUND_MIN_PAYOUT_MICROS = 1_000_000n;
export const REFUND_MAX_PAYOUTS_PER_RUN = 50;
export const REFUND_LINK_TTL_SECONDS = 300;
/** A relink to a DIFFERENT Solana wallet is paid only after this cooldown (48 h), so a phished relink can be noticed and reverted before money moves. A first link pays immediately. */
export const REFUND_RELINK_COOLDOWN_SECONDS = 48 * 3600;

export interface RefundLinkMessageParams {
  /** Host of the Pyre web origin (`new URL(WEB_ORIGIN).host`): wallets compare it with the requesting page and flag a mismatch. */
  domain: string;
  /** The Pyre web origin (`WEB_ORIGIN`). */
  uri: string;
  /** Checksummed Robinhood Chain address being proven. */
  address: `0x${string}`;
  /** Base58 Solana wallet being linked as the payout wallet. */
  solWallet: string;
  nonce: string;
  /** ISO time the challenge was issued; it expires REFUND_LINK_TTL_SECONDS later. */
  issuedAt: string;
}

/**
 * Exact bytes both wallets sign (UTF-8): an EIP-4361 (Sign-In with Ethereum) message bound to the
 * Pyre domain/URI, Robinhood Chain, a nonce and a 5-minute validity window, so wallets show the
 * requesting origin and flag a phishing page. The statement names the Solana wallet being linked
 * and the snapshot block. Deterministic from the params so the API can rebuild and validate it.
 */
export function refundLinkMessage(p: RefundLinkMessageParams): string {
  const issuedAt = new Date(p.issuedAt);
  return createSiweMessage({
    domain: p.domain,
    address: p.address,
    statement: `Link Solana wallet ${p.solWallet} as the payout wallet for this address's Pyre PYRE refund (snapshot block ${REFUND_SNAPSHOT.block}). This does not move funds or cost gas.`,
    uri: p.uri,
    version: "1",
    chainId: REFUND_SNAPSHOT.chainId,
    nonce: p.nonce,
    issuedAt,
    expirationTime: new Date(issuedAt.getTime() + REFUND_LINK_TTL_SECONDS * 1000),
  });
}

/** ETH price as an exact integer: USD × 1e8 per whole ETH. */
const PRICE_SCALE = 100_000_000n;
/** wei × price8 / WEI_MICROS_DIVISOR = USD micros (1e18 wei/ETH × 1e8 scale ÷ 1e6 micros/USD). */
const WEI_MICROS_DIVISOR = 100_000_000_000_000_000_000n; // 1e20

const scaledPrice = (ethPriceUsd: number): bigint => {
  if (!Number.isFinite(ethPriceUsd) || ethPriceUsd <= 0) throw new RangeError(`invalid ETH price: ${ethPriceUsd}`);
  const p = BigInt(Math.round(ethPriceUsd * Number(PRICE_SCALE)));
  if (p === 0n) throw new RangeError(`invalid ETH price: ${ethPriceUsd}`);
  return p;
};

/** USD micros worth of `wei` at `ethPriceUsd` (floored). */
export function weiToMicros(wei: bigint, ethPriceUsd: number): bigint {
  return (wei * scaledPrice(ethPriceUsd)) / WEI_MICROS_DIVISOR;
}

/** Wei worth `micros` USD at `ethPriceUsd` (floored). */
export function microsToWei(micros: bigint, ethPriceUsd: number): bigint {
  return (micros * WEI_MICROS_DIVISOR) / scaledPrice(ethPriceUsd);
}

export interface RefundRemaining {
  address: string;
  remainingWei: bigint;
}
export interface RefundAllocation {
  address: string;
  micros: bigint;
  wei: bigint;
}

/**
 * Pro-rata by remainingWei; each holder capped at remainingWei × ethPriceUsd; integer floor;
 * returns leftover micros (nothing above a cap is redistributed). An allocation that reaches its
 * cap settles the holder's whole remainder, so a holder whose remainder is worth less than one
 * micro-dollar settles with `micros: 0` and the program can finish. Pure.
 */
export function allocateRefunds(poolMicros: bigint, holders: RefundRemaining[], ethPriceUsd: number): { allocations: RefundAllocation[]; leftoverMicros: bigint } {
  const owed = holders.filter((h) => h.remainingWei > 0n);
  const totalWei = owed.reduce((acc, h) => acc + h.remainingWei, 0n);
  if (poolMicros <= 0n || totalWei === 0n) return { allocations: [], leftoverMicros: poolMicros > 0n ? poolMicros : 0n };
  const allocations: RefundAllocation[] = [];
  let spent = 0n;
  for (const h of owed) {
    const cap = weiToMicros(h.remainingWei, ethPriceUsd);
    const share = (poolMicros * h.remainingWei) / totalWei;
    const micros = share < cap ? share : cap;
    const wei = micros === cap ? h.remainingWei : microsToWei(micros, ethPriceUsd);
    if (micros === 0n && wei === 0n) continue;
    allocations.push({ address: h.address, micros, wei });
    spent += micros;
  }
  return { allocations, leftoverMicros: poolMicros - spent };
}

/**
 * Wei a holder can still be refunded given their post-snapshot holding: owedWei scaled by the
 * lowest balance they held after the snapshot (capped at the snapshot balance), floored.
 * Selling/moving shrinks it for good; buying more never raises it.
 */
export function refundEligibleWei(owedWei: bigint, balanceUnits: bigint, minBalanceUnits: bigint): bigint {
  if (balanceUnits <= 0n) return 0n;
  const held = minBalanceUnits < balanceUnits ? (minBalanceUnits > 0n ? minBalanceUnits : 0n) : balanceUnits;
  return (owedWei * held) / balanceUnits;
}

/** Wei still to allocate: max(0, eligibleWei − settledWei). */
export function refundRemainingWei(eligibleWei: bigint, settledWei: bigint): bigint {
  return eligibleWei > settledWei ? eligibleWei - settledWei : 0n;
}

export interface RefundSummaryDto {
  snapshot: typeof REFUND_SNAPSHOT;
  live: boolean;
  mint: string | null;
  holders: number;
  owedHolders: number;
  linkedHolders: number;
  totalOwedWei: string;
  totalEligibleWei: string;
  totalSettledWei: string;
  stillHoldingHolders: number;
  totalPaidMicros: string;
  poolMicros: string;
  feeBps: number;
}
export interface RefundPayoutDto {
  id: string;
  solWallet: string;
  usdMicros: string;
  lamports: string;
  status: "PENDING" | "SENT" | "CONFIRMED" | "FAILED";
  txSig: string | null;
  createdAt: string;
}
export interface RefundHolderDto {
  address: string;
  balanceUnits: string;
  currentBalanceUnits: string;
  minBalanceUnits: string;
  stillHolding: boolean;
  /** PYRE that landed in this address in its own buys through the snapshot; owed is capped at the cost of min(balance, bought). */
  boughtUnits: string;
  ethInWei: string;
  ethOutWei: string;
  owedWei: string;
  eligibleWei: string;
  settledWei: string;
  remainingWei: string;
  creditMicros: string;
  paidMicros: string;
  solWallet: string | null;
  linkedAt: string | null;
  /** Set after a relink to a different wallet: payouts to `solWallet` start at this time (ISO); null = active now. */
  linkPendingUntil: string | null;
  payouts: RefundPayoutDto[];
}
export interface RefundChallengeDto {
  message: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}
