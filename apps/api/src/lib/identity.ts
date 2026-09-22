import { prisma, type User } from "@pyre/db";
import { deriveWallet } from "@pyre/chain";
import type { Address } from "viem";
import { custodialSolWallet } from "./custodial.js";
import type { GoogleIdentity } from "./google.js";

/**
 * Assigns the custodial EVM wallet to a freshly created user. `walletIndex` is DB-generated
 * (autoincrement), so the address can only be derived after the row exists — hence the second write.
 * Idempotent: existing wallets are left untouched.
 */
const ensureWallet = async (user: User): Promise<User> => {
  if (user.wallet !== null) return user;
  const wallet = deriveWallet(user.walletIndex).address;
  return prisma.user.update({ where: { id: user.id }, data: { wallet } });
};

/**
 * Backfills the custodial Solana address for an existing user the first time it is read while
 * the Solana venue is enabled — same `walletIndex`, ed25519 branch. Idempotent; a no-op while the
 * venue is disabled (the address is a pure derivation, so nothing is lost by waiting).
 */
export const ensureSolWallet = async (user: User): Promise<User> => {
  if (user.solWallet !== null) return user;
  const solWallet = custodialSolWallet(user);
  if (solWallet === null) return user;
  return prisma.user.update({ where: { id: user.id }, data: { solWallet } });
};

/** Upserts a Google-login user by `sub` and guarantees a custodial wallet. */
export const upsertGoogleUser = async (id: GoogleIdentity): Promise<User> => {
  const existing = await prisma.user.findUnique({ where: { googleSub: id.sub } });
  if (existing) return ensureWallet(existing);
  const user = await prisma.user.create({
    data: { googleSub: id.sub, displayName: id.name, avatarUrl: id.picture },
  });
  return ensureWallet(user);
};

/** Upserts a wallet-login user by the proven external address (checksummed) and guarantees a custodial wallet. */
export const upsertWalletUser = async (authWallet: Address): Promise<User> => {
  const existing = await prisma.user.findUnique({ where: { authWallet } });
  if (existing) return ensureWallet(existing);
  const user = await prisma.user.create({ data: { authWallet } });
  return ensureWallet(user);
};
