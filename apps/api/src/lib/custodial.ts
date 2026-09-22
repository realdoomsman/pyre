import type { Address, PrivateKeyAccount } from "viem";
import { adapterFor, deriveWallet, getErc20Balance, getEthBalance, solanaEnabled, usdgAddress, type VenueAccount } from "@pyre/chain";
import type { User } from "@pyre/db";
import type { Chain } from "@pyre/shared";

/**
 * The platform-custodied signing account for a user's wallet. Every on-chain action a custodial
 * user takes (withdraw, stake, trade, top-up, bounty escrow) is server-signed with this
 * key, derived deterministically from the master seed at the user's `walletIndex`
 * (m/44'/60'/0'/0/{walletIndex}). Browsers never see a key.
 */
export const custodialAccount = (user: Pick<User, "walletIndex">): PrivateKeyAccount => deriveWallet(user.walletIndex).account;

/** The same user's custodial signer on a venue's chain (Solana: m/44'/501'/{walletIndex}'/0'). */
export const custodialVenueAccount = (user: Pick<User, "walletIndex">, chain: Chain): VenueAccount =>
  adapterFor(chain === "robinhood" ? "pons_v2" : "pump_fun").userWallet(user.walletIndex);

/** Native ETH balance (wei) of a custodial wallet at the latest block. */
export const custodialEthBalance = (wallet: Address): Promise<bigint> => getEthBalance(wallet);

/** USDG balance (6-decimal units) of a custodial wallet. */
export const custodialUsdgBalance = (wallet: Address): Promise<bigint> => getErc20Balance(usdgAddress(), wallet);

/** Custodial Solana address (base58) for a user, derived from the same `walletIndex`; null while the venue is disabled. */
export const custodialSolWallet = (user: Pick<User, "walletIndex">): string | null =>
  solanaEnabled() ? adapterFor("pump_fun").userWallet(user.walletIndex).address : null;

/** SOL balance (lamports) of a custodial Solana wallet; 0 while the venue is disabled. */
export const custodialSolBalance = (wallet: string | null): Promise<bigint> =>
  wallet && solanaEnabled() ? adapterFor("pump_fun").nativeBalance(wallet) : Promise.resolve(0n);

/**
 * Gas a custodial wallet must keep for one more simple transaction: ~21k gas × 0.1 gwei is a few
 * hundred million wei on Robinhood Chain; keep four orders of magnitude of headroom.
 */
export const GAS_RESERVE_WEI = 20_000_000_000_000n; // 0.00002 ETH

/**
 * What a custodial wallet keeps back on each chain: gas headroom on Robinhood Chain; on Solana the
 * rent-exempt minimum of a system account (~0.0009 SOL) plus a few signatures, so a wallet that
 * stakes or trades its whole balance is never garbage-collected mid-flight.
 */
export const GAS_RESERVE_BY_CHAIN: Record<Chain, bigint> = {
  robinhood: GAS_RESERVE_WEI,
  solana: 2_000_000n, // 0.002 SOL
};
