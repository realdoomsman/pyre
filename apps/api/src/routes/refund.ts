import { createHash } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { big, prisma, type RefundHolder, type RefundPayout } from "@pyre/db";
import { publicClient } from "@pyre/chain";
import {
  REFUND_FEE_BPS,
  REFUND_LEDGER_ACCOUNT,
  REFUND_LINK_TTL_SECONDS,
  REFUND_RELINK_COOLDOWN_SECONDS,
  REFUND_SNAPSHOT,
  refundEligibleWei,
  refundLinkMessage,
  refundRemainingWei,
  type RefundChallengeDto,
  type RefundHolderDto,
  type RefundPayoutDto,
  type RefundSummaryDto,
} from "@pyre/shared";
import { optionalAuth } from "../lib/auth.js";
import { writeAudit } from "../lib/audit.js";
import { cached } from "../lib/cache.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { sendCached } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { clientIp } from "../lib/ratelimit.js";
import { redis } from "../lib/redis.js";
import { env } from "../env.js";

/**
 * PYRE holder refunds. Holders in the snapshot (RefundHolder rows) are owed the ETH they put in;
 * refunds are paid in SOL to a Solana wallet the holder links by proving both wallets sign the
 * same message: the Robinhood Chain address (EIP-191, ERC-1271, or a custodial session that owns
 * it) and the Solana wallet (ed25519). Linking moves no money, so it is not gated by the payout freeze.
 */
export const refund = Router();

/**
 * Live link challenges kept per (address, requester IP): issuing past this evicts the oldest from
 * the SAME requester only, so nobody can evict another party's in-flight nonce by flooding
 * challenges for their address. Entries past the TTL are pruned on every issue, so the hash stays
 * bounded by (requesting IPs within 5 minutes) × this, and IPs are rate-limited.
 */
const MAX_LIVE_CHALLENGES_PER_REQUESTER = 4;
const PAYOUTS_SHOWN = 50;
const SUMMARY_TTL_MS = 30_000;

/** EIP-4361 binding: wallets compare this host with the page asking for the signature. */
const WEB_URL = new URL(env.WEB_ORIGIN);

/** Redis hash `nonce → "<issuedAt ISO>|<solWallet>|<requester hash>"` per checksummed address. */
const challengeKey = (address: Address): string => `refundlink:${address}`;
/** Requester tag stored with a nonce: a short salted hash of the client IP (no raw IPs in Redis). */
const requesterTag = (req: Request): string => createHash("sha256").update(`refundlink|${clientIp(req)}`).digest("hex").slice(0, 16);

const parseAddress = (raw: unknown): Address => {
  if (typeof raw !== "string" || !isAddress(raw, { strict: false })) throw new HttpError(400, "bad_address");
  return getAddress(raw);
};

/** Base58 32-byte ed25519 public key that decodes to a point on the curve; anything else cannot sign. */
const parseSolWallet = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length < 32 || raw.length > 44) throw new HttpError(400, "bad_sol_wallet");
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(raw);
  } catch {
    throw new HttpError(400, "bad_sol_wallet");
  }
  if (bytes.length !== 32) throw new HttpError(400, "bad_sol_wallet");
  try {
    ed25519.Point.fromHex(bytes);
  } catch {
    throw new HttpError(400, "bad_sol_wallet");
  }
  return bs58.encode(bytes);
};

const payoutDto = (p: RefundPayout): RefundPayoutDto => ({
  id: p.id,
  solWallet: p.solWallet,
  usdMicros: p.usdMicros.toString(),
  lamports: big(p.lamports).toString(),
  status: p.status,
  txSig: p.txSig,
  createdAt: p.createdAt.toISOString(),
});

/** Eligible refund for a holder row: owed scaled by the share of the snapshot PYRE never sold/moved. */
const eligibleWei = (h: Pick<RefundHolder, "owedWei" | "balanceUnits" | "minBalanceUnits">): bigint =>
  refundEligibleWei(big(h.owedWei), big(h.balanceUnits), big(h.minBalanceUnits));

export const holderDto = (h: RefundHolder, payouts: RefundPayout[]): RefundHolderDto => {
  const owed = big(h.owedWei);
  const settled = big(h.settledWei);
  const balance = big(h.balanceUnits);
  const min = big(h.minBalanceUnits);
  const eligible = refundEligibleWei(owed, balance, min);
  return {
    address: h.address,
    balanceUnits: balance.toString(),
    currentBalanceUnits: big(h.currentBalanceUnits).toString(),
    minBalanceUnits: min.toString(),
    stillHolding: min === balance,
    boughtUnits: big(h.boughtUnits).toString(),
    ethInWei: big(h.ethInWei).toString(),
    ethOutWei: big(h.ethOutWei).toString(),
    owedWei: owed.toString(),
    eligibleWei: eligible.toString(),
    settledWei: settled.toString(),
    remainingWei: refundRemainingWei(eligible, settled).toString(),
    creditMicros: h.creditMicros.toString(),
    paidMicros: h.paidMicros.toString(),
    solWallet: h.solWallet,
    linkedAt: h.linkedAt?.toISOString() ?? null,
    linkPendingUntil: h.linkPendingUntil && h.linkPendingUntil.getTime() > Date.now() ? h.linkPendingUntil.toISOString() : null,
    payouts: payouts.map(payoutDto),
  };
};

const loadHolderDto = async (address: Address): Promise<RefundHolderDto> => {
  const holder = await prisma.refundHolder.findUnique({
    where: { address },
    include: { payouts: { orderBy: { createdAt: "desc" }, take: PAYOUTS_SHOWN } },
  });
  if (!holder) throw new HttpError(404, "not_eligible");
  return holderDto(holder, holder.payouts);
};

const loadSummary = async (): Promise<RefundSummaryDto> => {
  const [holders, owedHolders, linkedHolders, sums, pool, rows] = await prisma.$transaction([
    prisma.refundHolder.count(),
    prisma.refundHolder.count({ where: { owedWei: { gt: 0 } } }),
    prisma.refundHolder.count({ where: { solWallet: { not: null } } }),
    prisma.refundHolder.aggregate({ _sum: { owedWei: true, settledWei: true, paidMicros: true } }),
    prisma.ledgerEntry.aggregate({ where: { account: REFUND_LEDGER_ACCOUNT }, _sum: { deltaMicros: true } }),
    // Eligibility is a per-row floor(owed × min / balance); SQL sums can't reproduce that rounding.
    prisma.refundHolder.findMany({ select: { owedWei: true, balanceUnits: true, minBalanceUnits: true } }),
  ]);
  let totalEligible = 0n;
  let stillHoldingHolders = 0;
  for (const r of rows) {
    totalEligible += eligibleWei(r);
    if (big(r.minBalanceUnits) === big(r.balanceUnits)) stillHoldingHolders++;
  }
  return {
    snapshot: REFUND_SNAPSHOT,
    live: env.PYRE_SOL_MINT !== undefined,
    mint: env.PYRE_SOL_MINT ?? null,
    holders,
    owedHolders,
    linkedHolders,
    stillHoldingHolders,
    totalOwedWei: big(sums._sum.owedWei ?? 0).toString(),
    totalEligibleWei: totalEligible.toString(),
    totalSettledWei: big(sums._sum.settledWei ?? 0).toString(),
    totalPaidMicros: (sums._sum.paidMicros ?? 0n).toString(),
    poolMicros: (pool._sum.deltaMicros ?? 0n).toString(),
    feeBps: REFUND_FEE_BPS,
  };
};

/** `GET /v1/refund` — program-wide totals; a full holder scan, so cached 30 s (in process + Redis) and at the edge. */
export const summaryHandler = async (_req: Request, res: Response): Promise<void> => {
  sendCached(res, await cached("refund.summary", SUMMARY_TTL_MS, loadSummary), { maxAge: 30, swr: 120 });
};

/** `GET /v1/refund/holders/:address` — one holder's position and latest payouts. */
export const holderHandler = async (req: Request, res: Response): Promise<void> => {
  res.json(await loadHolderDto(parseAddress(req.params.address)));
};

const ChallengeBody = z.object({ address: z.unknown(), solWallet: z.unknown() });

/** `POST /v1/refund/link/challenge` — `{address, solWallet}` → the EIP-4361 message both wallets sign. */
export const challengeHandler = async (req: Request, res: Response): Promise<void> => {
  const body = parse(ChallengeBody, req.body);
  const address = parseAddress(body.address);
  const solWallet = parseSolWallet(body.solWallet);
  const holder = await prisma.refundHolder.findUnique({
    where: { address },
    select: { owedWei: true, balanceUnits: true, minBalanceUnits: true },
  });
  if (!holder || eligibleWei(holder) <= 0n) throw new HttpError(404, "not_eligible");

  const nonce = generateSiweNonce();
  const issuedAt = new Date().toISOString();
  const requester = requesterTag(req);
  const key = challengeKey(address);
  const live = Object.entries(await redis.hgetall(key));
  const cutoff = Date.now() - REFUND_LINK_TTL_SECONDS * 1000;
  const expired = live.filter(([, v]) => !(Date.parse(v.slice(0, v.indexOf("|"))) > cutoff)).map(([n]) => n);
  const mine = live
    .filter(([n, v]) => !expired.includes(n) && v.endsWith(`|${requester}`))
    .sort((a, b) => a[1].localeCompare(b[1]));
  const evicted = mine.slice(0, Math.max(0, mine.length - MAX_LIVE_CHALLENGES_PER_REQUESTER + 1)).map(([n]) => n);
  const stale = [...expired, ...evicted];
  const tx = redis.multi();
  if (stale.length > 0) tx.hdel(key, ...stale);
  tx.hset(key, nonce, `${issuedAt}|${solWallet}|${requester}`);
  tx.expire(key, REFUND_LINK_TTL_SECONDS);
  await tx.exec();

  const dto: RefundChallengeDto = {
    message: refundLinkMessage({ domain: WEB_URL.host, uri: env.WEB_ORIGIN, address, solWallet, nonce, issuedAt }),
    nonce,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + REFUND_LINK_TTL_SECONDS * 1000).toISOString(),
  };
  res.json(dto);
};

const LinkBody = z.object({
  address: z.unknown(),
  solWallet: z.unknown(),
  nonce: z.string().min(1).max(128),
  solSignature: z.string().min(1).max(200),
  evmSignature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .max(20_000)
    .optional(),
});

const verifySol = (solWallet: string, message: string, signatureB64: string): boolean => {
  const sig = Buffer.from(signatureB64, "base64");
  if (sig.length !== 64) return false;
  try {
    return ed25519.verify(new Uint8Array(sig), new TextEncoder().encode(message), bs58.decode(solWallet));
  } catch {
    return false;
  }
};

const verifyEvm = async (address: Address, message: string, signature: Hex): Promise<boolean> => {
  try {
    if (await verifyMessage({ address, message, signature })) return true;
  } catch {
    // Not an EOA signature shape; fall through to ERC-1271.
  }
  try {
    return await publicClient().verifyMessage({ address, message, signature });
  } catch (err) {
    logger.warn({ err, address }, "refund link ERC-1271 check failed");
    return false;
  }
};

/**
 * `POST /v1/refund/link` — consumes the nonce first (HDEL that only one caller wins), rebuilds the
 * EIP-4361 message from the stored issuedAt/solWallet, validates its domain/URI/chain/time window,
 * then requires both wallet proofs. Relinking to a DIFFERENT wallet than the one already linked
 * starts a REFUND_RELINK_COOLDOWN_SECONDS cooldown before that wallet is paid; a first link (or
 * re-proving the same wallet) leaves payouts as they were.
 */
export const linkHandler = async (req: Request, res: Response): Promise<void> => {
  const body = parse(LinkBody, req.body);
  const address = parseAddress(body.address);
  const solWallet = parseSolWallet(body.solWallet);
  const key = challengeKey(address);

  const stored = await redis.hget(key, body.nonce);
  if (stored === null || (await redis.hdel(key, body.nonce)) !== 1) throw new HttpError(409, "challenge_expired");
  const [issuedAt = "", challengedSol] = stored.split("|");
  if (challengedSol !== solWallet || !Number.isFinite(Date.parse(issuedAt))) throw new HttpError(409, "challenge_expired");
  const message = refundLinkMessage({ domain: WEB_URL.host, uri: env.WEB_ORIGIN, address, solWallet, nonce: body.nonce, issuedAt });
  const fields = parseSiweMessage(message);
  const valid =
    validateSiweMessage({ message: fields, address, domain: WEB_URL.host, nonce: body.nonce, time: new Date() }) &&
    fields.uri === env.WEB_ORIGIN &&
    fields.chainId === REFUND_SNAPSHOT.chainId &&
    fields.version === "1";
  if (!valid) throw new HttpError(409, "challenge_expired");

  let via: "evm" | "custodial";
  let linkedByUserId: string | null = null;
  if (body.evmSignature !== undefined) {
    if (!(await verifyEvm(address, message, body.evmSignature as Hex))) throw new HttpError(401, "bad_evm_signature");
    via = "evm";
  } else if (req.user?.wallet != null && getAddress(req.user.wallet) === address) {
    via = "custodial";
    linkedByUserId = req.user.id;
  } else {
    throw new HttpError(401, "bad_evm_signature");
  }
  if (!verifySol(solWallet, message, body.solSignature)) throw new HttpError(401, "bad_sol_signature");

  const before = await prisma.refundHolder.findUnique({ where: { address }, select: { solWallet: true, linkPendingUntil: true } });
  if (!before) throw new HttpError(404, "not_eligible");
  const now = new Date();
  const linkPendingUntil =
    before.solWallet === null ? null : before.solWallet === solWallet ? before.linkPendingUntil : new Date(now.getTime() + REFUND_RELINK_COOLDOWN_SECONDS * 1000);
  await prisma.refundHolder.update({
    where: { address },
    data: { solWallet, linkedAt: now, linkedByUserId, linkPendingUntil },
  });
  await writeAudit({
    actorId: req.user?.id ?? null,
    actor: req.user ? `user:${req.user.id}` : "system",
    action: "REFUND_LINK",
    targetType: "RefundHolder",
    targetId: address,
    meta: { address, from: before.solWallet, to: solWallet, via, payoutsFrom: linkPendingUntil?.toISOString() ?? null },
  });
  res.json(await loadHolderDto(address));
};

refund.get("/", wrap(summaryHandler));
refund.get("/holders/:address", wrap(holderHandler));
refund.post("/link/challenge", wrap(challengeHandler));
refund.post("/link", optionalAuth, wrap(linkHandler));
