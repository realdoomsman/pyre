import type { Response } from "express";
import type { Address, Hash } from "viem";
import { prisma, type User } from "@pyre/db";
import { relayUsdgAuthorization, signUsdgAuthorization, usdgAddress, verifyErc20Transfer } from "@pyre/chain";
import { DAILY_CHARGE_CAP_USD, MAX_CHARGE_USD } from "@pyre/shared";
import { custodialAccount } from "../lib/custodial.js";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
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

const MAX_CHARGE_MICROS = BigInt(MAX_CHARGE_USD) * 1_000_000n;
const DAILY_CHARGE_CAP_MICROS = BigInt(DAILY_CHARGE_CAP_USD) * 1_000_000n;

/**
 * Platform ceiling on what an app may take from a signed-in user: one charge is at most
 * `MAX_CHARGE_USD` and a user's charges by one app at most `DAILY_CHARGE_CAP_USD` per UTC day. The
 * price itself always comes from the live manifest (product / function), never from the request.
 * The daily reservation is one conditional UPDATE (`used + add <= cap`), so concurrent charges
 * serialize on the row and none can out-read a stale total. Reserved BEFORE the transfer; the
 * returned handle releases it only if the transfer then fails. Throws `402 charge_limit`.
 */
export async function reserveCharge(userId: string, appId: string, addMicros: bigint): Promise<() => Promise<void>> {
  const day = new Date().toISOString().slice(0, 10);
  const limit = (reason: "single" | "daily", usedMicros: bigint): HttpError =>
    new HttpError(402, "charge_limit", {
      reason,
      priceUsd: Number(addMicros) / 1e6,
      maxChargeUsd: MAX_CHARGE_USD,
      dailyCapUsd: DAILY_CHARGE_CAP_USD,
      usedTodayUsd: Number(usedMicros) / 1e6,
    });
  if (addMicros > MAX_CHARGE_MICROS) throw limit("single", 0n);
  await prisma.dailyAppCharge.upsert({
    where: { userId_appId_day: { userId, appId, day } },
    create: { userId, appId, day, usedMicros: 0n },
    update: {},
  });
  const reserved = await prisma.dailyAppCharge.updateMany({
    where: { userId, appId, day, usedMicros: { lte: DAILY_CHARGE_CAP_MICROS - addMicros } },
    data: { usedMicros: { increment: addMicros } },
  });
  if (reserved.count === 0) {
    const row = await prisma.dailyAppCharge.findUnique({ where: { userId_appId_day: { userId, appId, day } } });
    throw limit("daily", row?.usedMicros ?? 0n);
  }
  return async () => {
    await prisma.dailyAppCharge
      .updateMany({ where: { userId, appId, day }, data: { usedMicros: { decrement: addMicros } } })
      .catch((err: unknown) => logger.error({ err, userId, appId }, "charge cap release failed"));
  };
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
