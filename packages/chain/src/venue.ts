/**
 * A launch venue is a chain + launchpad pair. Every venue-specific detail (address formats,
 * native asset, how a coin is created, where creator fees accrue, how a buyback is executed,
 * how trades are indexed) lives behind this interface, so the api and runner never branch on
 * "which chain" except to pick the adapter.
 *
 * Amounts are native base units as bigint everywhere (wei on Robinhood Chain, lamports on
 * Solana; token units in the coin's own decimals). Strings are venue-formatted (0x… / base58).
 */

export type Chain = "robinhood" | "solana";
export type Launchpad = "pons_v2" | "pump_fun";

export interface NativeAsset {
  symbol: "ETH" | "SOL";
  decimals: 18 | 9;
}

export interface VenueInfo {
  chain: Chain;
  launchpad: Launchpad;
  native: NativeAsset;
  /** Coin decimals on this launchpad (PONS 18, pump 6). */
  tokenDecimals: number;
  /** Total supply in token units (both venues mint 1B). */
  totalSupplyUnits: bigint;
  /** Human labels. */
  chainLabel: string;
  launchpadLabel: string;
  explorerTxUrl(tx: string): string;
  explorerAddressUrl(address: string): string;
  explorerTokenUrl(token: string): string;
  /** The launchpad's own coin page. */
  launchpadUrl(token: string): string;
}

/** Signing identity on a venue. `secret` never leaves the process. */
export interface VenueAccount {
  chain: Chain;
  address: string;
  /** Opaque signer: viem LocalAccount on Robinhood, web3.js Keypair on Solana. */
  signer: unknown;
}

export interface VenueLaunchParams {
  name: string;
  symbol: string;
  /** Public https URL of the coin image. */
  imageUrl: string;
  /** Public https URL of a metadata JSON (pump) — venues that need none ignore it. */
  metadataUrl: string;
  description: string;
  socials: { website?: string; twitter?: string };
}

/** Curve = 0, graduated/pool = 2 (mirrors PONS `LaunchPhase`; 1 and 3 are PONS-internal transitions). */
export type VenuePhase = 0 | 1 | 2 | 3;

export interface VenueLaunchState {
  exists: boolean;
  token: string;
  /** Bonding curve account/contract. */
  curve: string;
  /** Pool id/address once graduated; null before. */
  pool: string | null;
  phase: VenuePhase;
  /** 0–1 toward graduation; 1 once graduated. */
  progress: number;
  /** Native raised on the curve so far and the graduation threshold, base units. */
  raisedNative: bigint;
  graduationNative: bigint;
  /** Spot price in native per whole token, and USD given the native price. */
  priceNative: number;
  totalSupplyUnits: bigint;
  circulatingUnits: bigint;
  burnedUnits: bigint;
}

export interface VenueFees {
  /** Fees earned but not yet claimable (on the curve/hook for PONS; 0 on pump where fees land in the vault directly). */
  unswept: bigint;
  /** Claimable now by the creator wallet. */
  claimable: bigint;
}

export interface VenueTrade {
  hash: string;
  /** Block/slot. */
  block: number;
  ts: number;
  side: "buy" | "sell";
  wallet: string;
  tokenUnits: bigint;
  quoteNative: bigint;
  /** quoteNative / tokenUnits in whole units. */
  priceNative: number;
}

export interface VenueHolder {
  address: string;
  units: bigint;
  share: number;
  system: "liquidity" | "locked" | "dead" | "vault" | null;
}

export interface VenueQuote {
  /** What the caller pays (buy) or receives (sell) in native base units, fees included. */
  native: bigint;
  tokenUnits: bigint;
  priceNative: number;
  /** Total fee bps taken by the launchpad on this trade. */
  feeBps: number;
  /** Fraction of the curve/pool consumed by this trade, for price-impact display. */
  impact: number;
}

export interface VenueTxResult {
  hash: string;
  block: number;
}

export interface VenueBuyResult extends VenueTxResult {
  tokenUnits: bigint;
  spentNative: bigint;
}

export interface VenueSellResult extends VenueTxResult {
  receivedNative: bigint;
}

export interface VenueBurnResult extends VenueTxResult {
  burnedUnits: bigint;
}

/**
 * One adapter per launchpad. Implementations: `ponsAdapter` (Robinhood Chain, PONS v2) and
 * `pumpAdapter` (Solana, pump.fun). All methods are network-bound; none hold state.
 */
export interface VenueAdapter {
  readonly info: VenueInfo;

  // Keys — same master seed, venue-specific derivation.
  treasury(): VenueAccount;
  userWallet(walletIndex: number): VenueAccount;
  appWallet(keypairIndex: number): VenueAccount;
  isAddress(value: string): boolean;
  isTxHash(value: string): boolean;

  // Native asset.
  nativeBalance(address: string): Promise<bigint>;
  transferNative(from: VenueAccount, to: string, amount: bigint): Promise<VenueTxResult>;
  /** Confirms an inbound transfer to `to` of at least `minAmount` from `from` (stake verification). */
  verifyNativeTransfer(hash: string, to: string, minAmount: bigint, from?: string): Promise<{ ok: boolean; from: string; amount: bigint; reason?: string }>;
  /** Native/USD spot price (ETH or SOL). */
  nativePriceUsd(): Promise<number>;

  // Launch.
  /** Cost the launching wallet must hold (launchpad fee + gas headroom). */
  predictLaunchCost(from: string): Promise<bigint>;
  /** Whether the launchpad currently accepts launches (kill switches, gating). */
  canLaunch(from: string): Promise<{ ok: boolean; reason?: string }>;
  launch(from: VenueAccount, params: VenueLaunchParams): Promise<{ hash: string; block: number; token: string; curve: string }>;
  readLaunch(token: string): Promise<VenueLaunchState>;

  // Creator fees.
  accruingFees(token: string, creator: string): Promise<VenueFees>;
  /** Moves earned fees to the claimable place, when the venue needs an explicit step; no-op otherwise. */
  sweepFees(account: VenueAccount, token: string): Promise<{ swept: boolean; hash?: string; reason?: string }>;
  /** Claims everything claimable to `account.address`. `{ amount: 0n }` without a tx when nothing is owed. */
  claimFees(account: VenueAccount, token: string): Promise<{ amount: bigint; hash: string | null }>;

  // Trading (custodial, server-signed).
  /** `buyer` refines venue fees keyed to the recipient (PONS snipe tax); a generic wallet is assumed when omitted. */
  quoteBuy(token: string, spendNative: bigint, buyer?: string): Promise<VenueQuote>;
  quoteSell(token: string, tokenUnits: bigint): Promise<VenueQuote>;
  buy(account: VenueAccount, token: string, spendNative: bigint, minTokenUnits: bigint): Promise<VenueBuyResult>;
  sell(account: VenueAccount, token: string, tokenUnits: bigint, minNative: bigint): Promise<VenueSellResult>;
  tokenBalance(token: string, address: string): Promise<bigint>;
  transferToken(from: VenueAccount, token: string, to: string, units: bigint): Promise<VenueTxResult>;

  // Burn + attestation.
  burn(account: VenueAccount, token: string, units: bigint): Promise<VenueBurnResult>;
  /** Writes `PYRE‖0x01‖sha256` on chain from the treasury: zero-value self-tx calldata on EVM, memo tx on Solana. `digestHex` may carry a 0x prefix. */
  attest(account: VenueAccount, digestHex: string): Promise<VenueTxResult>;
  /** Reads an attestation back from a tx, or null when the tx carries none. `digestHex` is 0x-prefixed on every venue, matching `attestationHash`. */
  readAttestation(hash: string): Promise<{ digestHex: string; version: number } | null>;

  // Indexing.
  currentBlock(): Promise<number>;
  trades(token: string, fromBlock: number, toBlock: number): Promise<VenueTrade[]>;
  holders(token: string, limit: number): Promise<VenueHolder[]>;
}
