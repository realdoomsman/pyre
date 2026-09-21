import { deriveAppWallet, getEthBalance, transferEth, treasury, type DerivedWallet } from "@pyre/chain";
import type { Logger } from "pino";
import { parseEther, type Hash } from "viem";

/** ETH kept in every app wallet so it can always sign its own sweeps and claims (≈50 txs at 0.05 gwei). */
export const APP_GAS_RESERVE_WEI = parseEther("0.0005");
/** Below this an app wallet may fail to sign a sweep; the treasury tops it back up to the reserve. */
export const APP_GAS_LOW_WEI = parseEther("0.0001");
/** The treasury never spends below this on app gas or launches, so buybacks, refunds and payouts keep working. */
export const TREASURY_FLOOR_WEI = parseEther("0.01");

/**
 * The app's custodial wallet (PONS deployer + creatorFeeRecipient). `App.walletAddress` is written by
 * the API at launch creation from the same derivation; a mismatch means the master seed changed and
 * signing for this app would move someone else's funds, so it is fatal.
 */
export function appWallet(app: { id: string; keypairIndex: number; walletAddress: string | null }): DerivedWallet {
  const wallet = deriveAppWallet(app.keypairIndex);
  if (app.walletAddress && app.walletAddress.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`app ${app.id}: derived wallet ${wallet.address} does not match App.walletAddress ${app.walletAddress}`);
  }
  return wallet;
}

export interface TopUpResult {
  hash: Hash | null;
  /** Wei moved from the treasury. */
  wei: bigint;
  /** App wallet balance after the top-up (or the untouched balance). */
  balanceWei: bigint;
}

/**
 * Funds `wallet` from the treasury up to `targetWei` when its balance is below `whenBelowWei`,
 * never taking the treasury under its floor. Returns what moved so callers can audit it.
 */
export async function topUpFromTreasury(wallet: DerivedWallet, targetWei: bigint, whenBelowWei: bigint, log: Logger): Promise<TopUpResult> {
  const balanceWei = await getEthBalance(wallet.address);
  if (balanceWei >= whenBelowWei) return { hash: null, wei: 0n, balanceWei };
  const wei = targetWei - balanceWei;
  const t = treasury();
  const treasuryWei = await getEthBalance(t.address);
  if (treasuryWei - wei < TREASURY_FLOOR_WEI) {
    throw new Error(`treasury ${t.address} holds ${treasuryWei} wei; funding ${wei} wei to ${wallet.address} would breach the ${TREASURY_FLOOR_WEI} wei floor`);
  }
  const hash = await transferEth(t.account, wallet.address, wei);
  log.info({ to: wallet.address, wei: wei.toString(), hash }, "app wallet funded from treasury");
  return { hash, wei, balanceWei: balanceWei + wei };
}
