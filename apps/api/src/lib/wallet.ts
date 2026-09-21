import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { createSiweMessage, generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { ROBINHOOD_CHAIN_ID } from "@pyre/shared";
import { env } from "../env.js";
import { redis } from "./redis.js";
import { logger } from "./logger.js";

/**
 * External-wallet login (EIP-6963 injected wallets), secondary to Google. Challenge/response:
 * the API issues an EIP-4361 (Sign-In with Ethereum) message bound to the address, the platform
 * domain/URI, the chain and a random nonce, stored in Redis for five minutes; the wallet signs it
 * with `personal_sign` (EIP-191) and the API rebuilds the exact message from the stored fields,
 * validates every field, and recovers the signer with viem. The domain binding is what lets
 * wallets show "pyre.fun wants you to sign in" and flag a phishing page asking for the same
 * signature. Several challenges may be live per address (a page reload or a second tab does not
 * invalidate the first); each is single-use.
 */
export const CHALLENGE_TTL_SECONDS = 5 * 60;
/** Live challenges kept per address; issuing past this evicts the oldest so a flood cannot grow the hash. */
const MAX_LIVE_CHALLENGES = 8;
export const CHALLENGE_STATEMENT = "Sign in to Pyre. This request will not trigger a blockchain transaction or cost any gas.";

const WEB_URL = new URL(env.WEB_ORIGIN);

/** Redis hash `nonce → issuedAt ISO` per address; the hash TTL is refreshed on every issue. (New namespace: the pre-SIWE key held a string.) */
const challengeKey = (address: Address): string => `walletsiwe:${address}`;

/** The exact EIP-4361 text the wallet signs. Deterministic from (address, nonce, issued) so verify can rebuild it. */
export const challengeMessage = (address: Address, nonce: string, issuedIso: string): string => {
  const issuedAt = new Date(issuedIso);
  return createSiweMessage({
    domain: WEB_URL.host,
    address,
    statement: CHALLENGE_STATEMENT,
    uri: env.WEB_ORIGIN,
    version: "1",
    chainId: ROBINHOOD_CHAIN_ID,
    nonce,
    issuedAt,
    expirationTime: new Date(issuedAt.getTime() + CHALLENGE_TTL_SECONDS * 1000),
  });
};

export interface WalletChallenge {
  message: string;
  nonce: string;
  issued: string;
  expiresAt: string;
}

/** Issues (and stores) a fresh challenge for `address` alongside any earlier unconsumed ones. */
export const walletChallenge = async (rawAddress: string): Promise<WalletChallenge> => {
  const address = getAddress(rawAddress);
  const nonce = generateSiweNonce();
  const issued = new Date().toISOString();
  const key = challengeKey(address);
  const live = await redis.hgetall(key);
  const stale = Object.entries(live)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .slice(0, Math.max(0, Object.keys(live).length - MAX_LIVE_CHALLENGES + 1))
    .map(([n]) => n);
  const tx = redis.multi();
  if (stale.length > 0) tx.hdel(key, ...stale);
  tx.hset(key, nonce, issued);
  tx.expire(key, CHALLENGE_TTL_SECONDS);
  await tx.exec();
  return {
    message: challengeMessage(address, nonce, issued),
    nonce,
    issued,
    expiresAt: new Date(Date.parse(issued) + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
  };
};

/**
 * Checks that `signature` is `address`'s EIP-191 signature over one of its live challenges and
 * consumes that challenge (an `HDEL` that only one caller can win, so a captured signature is
 * single-use). Every EIP-4361 field of the rebuilt message is validated — domain, URI, chain,
 * address, nonce, issued/expiry window — before the signer is recovered. Fails CLOSED when Redis
 * is unreachable: refusing a login beats an unbounded replay window.
 */
export const verifyWalletLogin = async (rawAddress: string, signature: Hex): Promise<boolean> => {
  const address = getAddress(rawAddress);
  const key = challengeKey(address);
  let live: Record<string, string>;
  try {
    live = await redis.hgetall(key);
  } catch (err) {
    logger.error({ err }, "wallet challenge lookup failed");
    return false;
  }
  const now = new Date();
  // Newest first: the signature almost always belongs to the latest challenge.
  for (const [nonce, issued] of Object.entries(live).sort((a, b) => b[1].localeCompare(a[1]))) {
    const message = challengeMessage(address, nonce, issued);
    const fields = parseSiweMessage(message);
    const valid =
      validateSiweMessage({ message: fields, address, domain: WEB_URL.host, nonce, time: now }) &&
      fields.uri === env.WEB_ORIGIN &&
      fields.chainId === ROBINHOOD_CHAIN_ID &&
      fields.version === "1";
    if (!valid) continue;
    let signed: boolean;
    try {
      signed = await verifyMessage({ address, message, signature });
    } catch {
      signed = false;
    }
    if (!signed) continue;
    try {
      return (await redis.hdel(key, nonce)) === 1;
    } catch (err) {
      logger.error({ err }, "wallet challenge consume failed");
      return false;
    }
  }
  return false;
};
