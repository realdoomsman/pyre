import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { redis } from "./redis.js";
import { logger } from "./logger.js";

/**
 * External-wallet login (EIP-6963 injected wallets), secondary to Google. Challenge/response:
 * the API issues a nonce bound to the address, stored in Redis for five minutes; the wallet signs
 * the human-readable message with `personal_sign` (EIP-191) and the API recovers the signer with
 * viem's `verifyMessage`. One live challenge per address; verifying consumes it so a captured
 * signature cannot be replayed.
 */
export const CHALLENGE_TTL_SECONDS = 5 * 60;

const challengeKey = (address: Address): string => `walletchal:${address}`;

/** The exact text the wallet signs. Deterministic from (address, nonce, issued) so verify can rebuild it. */
export const challengeMessage = (address: Address, nonce: string, issuedIso: string): string =>
  `Pyre sign-in\nAddress: ${address}\nNonce: ${nonce}\nIssued: ${issuedIso}`;

export interface WalletChallenge {
  message: string;
  nonce: string;
  issued: string;
  expiresAt: string;
}

/** Issues (and stores) a fresh challenge for `address`, replacing any earlier unconsumed one. */
export const walletChallenge = async (rawAddress: string): Promise<WalletChallenge> => {
  const address = getAddress(rawAddress);
  const nonce = randomBytes(16).toString("hex");
  const issued = new Date().toISOString();
  await redis.set(challengeKey(address), `${nonce} ${issued}`, "EX", CHALLENGE_TTL_SECONDS);
  return {
    message: challengeMessage(address, nonce, issued),
    nonce,
    issued,
    expiresAt: new Date(Date.parse(issued) + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
  };
};

/**
 * Consumes the live challenge for `address` and checks that `signature` is `address`'s EIP-191
 * signature over it. The challenge is deleted before the signature check so a rejected attempt
 * costs the caller a new challenge (and a captured signature is single-use). Fails CLOSED when
 * Redis is unreachable: refusing a login beats an unbounded replay window.
 */
export const verifyWalletLogin = async (rawAddress: string, signature: Hex): Promise<boolean> => {
  const address = getAddress(rawAddress);
  let stored: string | null;
  try {
    stored = await redis.getdel(challengeKey(address));
  } catch (err) {
    logger.error({ err }, "wallet challenge lookup failed");
    return false;
  }
  if (!stored) return false;
  const [nonce, issued] = stored.split(" ");
  if (!nonce || !issued) return false;
  const message = challengeMessage(address, nonce, issued);
  try {
    return await verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
};
