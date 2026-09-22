import type { Address } from "viem";
import { big, prisma, type User } from "@pyre/db";
import { getErc20Balance } from "@pyre/chain";
import { VENUES } from "@pyre/shared";
import { logger } from "../lib/logger.js";
import { adapterOf } from "../lib/venue.js";
import type { HostContext } from "./resolve.js";

export interface HolderInfo {
  isHolder: boolean;
  /** Whole tokens held. */
  balance: number;
  /** Whole tokens required by the app's holder tier (0 = any positive balance). */
  minHold: number;
}

const CHAIN_TTL_MS = 60_000;
const chainCache = new Map<string, { amount: bigint; expires: number }>();

/**
 * Holder tier of the user for the app's coin, keyed by their custodial wallet on the coin's
 * chain: the indexed `HolderBalance` snapshot when present, else a live balance read on the
 * launch token (cached 60s).
 */
export async function holderInfo(ctx: HostContext, user: Pick<User, "wallet" | "solWallet"> | null | undefined): Promise<HolderInfo> {
  const minHold = ctx.deployment?.manifest.holderTier?.minHoldTokens ?? 0;
  const token = ctx.app.tokenAddress;
  const wallet = ctx.app.chain === "solana" ? user?.solWallet : user?.wallet;
  if (!wallet || !token) return { isHolder: false, balance: 0, minHold };
  let amount: bigint;
  const row = await prisma.holderBalance.findUnique({
    where: { appId_wallet: { appId: ctx.app.id, wallet } },
    select: { amount: true },
  });
  if (row) amount = big(row.amount);
  else {
    const key = `${token}:${wallet}`;
    const hit = chainCache.get(key);
    if (hit && hit.expires > Date.now()) amount = hit.amount;
    else {
      try {
        amount = ctx.app.chain === "robinhood" ? await getErc20Balance(token as Address, wallet as Address) : await adapterOf(ctx.app).tokenBalance(token, wallet);
      } catch (err) {
        logger.warn({ err, wallet, token }, "host: on-chain balance lookup failed");
        amount = 0n;
      }
      chainCache.set(key, { amount, expires: Date.now() + CHAIN_TTL_MS });
      if (chainCache.size > 10_000) {
        const now = Date.now();
        for (const [k, v] of chainCache) if (v.expires <= now) chainCache.delete(k);
      }
    }
  }
  const balance = Number(amount / 10n ** BigInt(VENUES[ctx.app.launchpad].tokenDecimals));
  return { isHolder: amount > 0n && balance >= minHold, balance, minHold };
}
