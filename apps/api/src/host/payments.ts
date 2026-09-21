import type { Response } from "express";
import type { Address, Hash } from "viem";
import type { User } from "@pyre/db";
import { relayUsdgAuthorization, signUsdgAuthorization, usdgAddress, verifyErc20Transfer } from "@pyre/chain";
import { custodialAccount } from "../lib/custodial.js";
import { TREASURY_WALLET } from "../lib/treasury.js";

/**
 * In-app payments are USDG (6 decimals) on Robinhood Chain, so one USD micro is one USDG unit.
 * The user's custodial wallet signs an EIP-3009 `TransferWithAuthorization` and the treasury relays
 * it, paying the gas: a wallet only ever needs USDG, never ETH.
 */

/** An authorization is only usable for this long; a relay that stalls past it is dead, not replayable. */
const AUTHORIZATION_TTL_MS = 10 * 60_000;

/**
 * Sends the `402 insufficient_funds` funding gate. `depositAddress` is the user's own custodial
 * wallet: topping it up with USDG on Robinhood Chain is the only fix.
 */
export function sendInsufficientFunds(res: Response, priceMicros: bigint, balanceUnits: bigint, wallet: Address): void {
  res.status(402).json({
    error: "insufficient_funds",
    priceUsd: Number(priceMicros) / 1e6,
    balanceUsd: Number(balanceUnits) / 1e6,
    depositAddress: wallet,
  });
}

/**
 * Moves `units` USDG from the payer's custodial wallet to the treasury and returns the mined
 * transaction hash. Throws when the transfer did not land or did not carry the full amount.
 */
export async function chargeUsdg(payer: Pick<User, "walletIndex">, units: bigint): Promise<Hash> {
  const token = usdgAddress();
  const auth = await signUsdgAuthorization(custodialAccount(payer), {
    to: TREASURY_WALLET,
    units,
    validBefore: BigInt(Math.floor((Date.now() + AUTHORIZATION_TTL_MS) / 1000)),
  });
  const hash = await relayUsdgAuthorization(auth);
  const check = await verifyErc20Transfer(hash, { token, to: TREASURY_WALLET, minUnits: units });
  if (!check.ok) throw new Error(`USDG transfer ${hash} did not deliver ${units} units to the treasury`);
  return hash;
}
