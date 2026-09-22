import type { Address, PrivateKeyAccount } from "viem";
import { deriveWallet, getErc20Balance, getEthBalance, usdgAddress } from "@pyre/chain";
import type { User } from "@pyre/db";

/**
 * The platform-custodied signing account for a user's wallet. Every on-chain action a custodial
 * user takes (withdraw, stake, trade, top-up, bounty escrow) is server-signed with this
 * key, derived deterministically from the master seed at the user's `walletIndex`
 * (m/44'/60'/0'/0/{walletIndex}). Browsers never see a key.
 */
export const custodialAccount = (user: Pick<User, "walletIndex">): PrivateKeyAccount => deriveWallet(user.walletIndex).account;

/** Native ETH balance (wei) of a custodial wallet at the latest block. */
export const custodialEthBalance = (wallet: Address): Promise<bigint> => getEthBalance(wallet);

/** USDG balance (6-decimal units) of a custodial wallet. */
export const custodialUsdgBalance = (wallet: Address): Promise<bigint> => getErc20Balance(usdgAddress(), wallet);

/**
 * Gas a custodial wallet must keep for one more simple transaction: ~21k gas × 0.1 gwei is a few
 * hundred million wei on Robinhood Chain; keep four orders of magnitude of headroom.
 */
export const GAS_RESERVE_WEI = 20_000_000_000_000n; // 0.00002 ETH
