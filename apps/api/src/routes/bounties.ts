import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { big, dec, prisma } from "@pyre/db";
import { getEthPriceUsd, transferEth } from "@pyre/chain";
import { BountyBody, ethToWei, usdMicrosFromWei } from "@pyre/shared";
import { requireAuth } from "../lib/auth.js";
import { writeAudit } from "../lib/audit.js";
import { USER_REF_SELECT, bountyDto } from "../lib/dto.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { publishEvent } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import { TREASURY_ACCOUNT, TREASURY_WALLET } from "../lib/treasury.js";
import { custodialAccount, custodialEthBalance, GAS_RESERVE_WEI } from "../lib/custodial.js";

export const bounties = Router();

const BOUNTY_INCLUDE = { author: { select: USER_REF_SELECT }, claimant: { select: USER_REF_SELECT } } as const;

/** Escrow below this is not worth a payout tx (0.001 ETH). */
export const MIN_BOUNTY_WEI = 1_000_000_000_000_000n;

bounties.get(
  "/apps/:slug/bounties",
  wrap(async (req, res) => {
    const app = await prisma.app.findUnique({ where: { slug: req.params.slug! }, select: { id: true } });
    if (!app) throw new HttpError(404, "app_not_found");
    const rows = await prisma.bounty.findMany({
      where: { appId: app.id },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
      include: BOUNTY_INCLUDE,
    });
    res.json({ items: rows.map(bountyDto) });
  }),
);

/** Escrows ETH from the caller's custodial wallet into the treasury against a merged-PR payout. */
export const createBountyHandler = async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const app = await prisma.app.findUnique({ where: { slug: req.params.slug! } });
  if (!app) throw new HttpError(404, "app_not_found");
  if (app.status !== "LIVE" && app.status !== "DORMANT") throw new HttpError(409, "app_not_live");
  if (!user.wallet) throw new HttpError(400, "wallet_required");
  const body = parse(BountyBody, req.body);
  const wei = ethToWei(body.eth);
  if (wei < MIN_BOUNTY_WEI) throw new HttpError(400, "bounty_too_small", { minWei: MIN_BOUNTY_WEI.toString() });
  const balance = await custodialEthBalance(user.wallet as Address);
  const need = wei + GAS_RESERVE_WEI;
  if (balance < need) throw new HttpError(400, "insufficient_balance", { needWei: need.toString(), haveWei: balance.toString() });
  let escrowTx: string;
  try {
    escrowTx = await transferEth(custodialAccount(user), TREASURY_WALLET, wei);
  } catch (err) {
    logger.error({ err, appId: app.id, userId: user.id }, "bounty escrow transfer failed");
    throw new HttpError(502, "escrow_failed");
  }
  const usdMicros = usdMicrosFromWei(wei, await getEthPriceUsd());
  const bounty = await prisma.$transaction(async (tx) => {
    const created = await tx.bounty.create({
      data: { appId: app.id, authorId: user.id, title: body.title, description: body.description, wei: dec(wei), escrowTx },
      include: BOUNTY_INCLUDE,
    });
    await tx.ledgerEntry.create({
      data: { account: "TREASURY", deltaMicros: usdMicros, refType: "Bounty", refId: created.id, memo: "bounty escrow" },
    });
    return created;
  });
  res.status(201).json(bountyDto(bounty));
};

bounties.post("/apps/:slug/bounties", requireAuth, wrap(createBountyHandler));

const ClaimBody = z.object({ prNumber: z.number().int().positive() });

bounties.post(
  "/bounties/:id/claim",
  requireAuth,
  wrap(async (req, res) => {
    const user = req.user!;
    if (!user.wallet) throw new HttpError(400, "wallet_required");
    const body = parse(ClaimBody, req.body);
    const bounty = await prisma.bounty.findUnique({ where: { id: req.params.id! } });
    if (!bounty) throw new HttpError(404, "bounty_not_found");
    if (bounty.status !== "OPEN") throw new HttpError(409, "bounty_not_open");
    const pr = await prisma.pullRequest.findUnique({ where: { appId_number: { appId: bounty.appId, number: body.prNumber } } });
    if (!pr) throw new HttpError(404, "pr_not_found");
    if (pr.status !== "MERGED") throw new HttpError(409, "pr_not_merged");
    // Paying out requires PROVEN PR authorship: `authorWallet` is set only once the PR author's GitHub
    // identity is linked to a Pyre wallet. Paying an unprovable claimant would let anyone drain a
    // bounty's escrowed ETH, so refuse rather than trust the caller's word.
    const wallets = [user.wallet, user.authWallet].filter((w): w is string => typeof w === "string").map((w) => w.toLowerCase());
    if (!pr.authorWallet || !wallets.includes(pr.authorWallet.toLowerCase())) throw new HttpError(403, "pr_author_unverified");

    // Atomic OPEN→CLAIMED so a concurrent runner payout cannot double-pay.
    const claimed = await prisma.bounty.updateMany({
      where: { id: bounty.id, status: "OPEN" },
      data: { status: "CLAIMED", claimantId: user.id, claimantWallet: user.wallet, prNumber: body.prNumber, claimedAt: new Date() },
    });
    if (claimed.count === 0) throw new HttpError(409, "bounty_not_open");

    let payoutTx: string;
    try {
      payoutTx = await transferEth(TREASURY_ACCOUNT, user.wallet as Address, big(bounty.wei));
    } catch (err) {
      logger.error({ err, bountyId: bounty.id }, "bounty payout failed");
      // The payout tx never landed; release the bounty so it can be claimed again instead of bricking it in CLAIMED.
      await prisma.bounty.updateMany({
        where: { id: bounty.id, status: "CLAIMED" },
        data: { status: "OPEN", claimantId: null, claimantWallet: null, prNumber: null, claimedAt: null },
      });
      throw new HttpError(502, "payout_failed", { bountyId: bounty.id, status: "OPEN" });
    }
    const usdMicros = usdMicrosFromWei(big(bounty.wei), await getEthPriceUsd());
    const paid = await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.create({
        data: { account: "TREASURY", deltaMicros: -usdMicros, refType: "Payout", refId: bounty.id, memo: `bounty payout ${payoutTx}` },
      });
      return tx.bounty.update({ where: { id: bounty.id }, data: { status: "PAID", payoutTx }, include: BOUNTY_INCLUDE });
    });
    await writeAudit({
      actorId: user.id,
      actor: `user:${user.id}`,
      action: "BOUNTY_PAYOUT",
      targetType: "Bounty",
      targetId: bounty.id,
      meta: { appId: bounty.appId, prNumber: body.prNumber, wei: big(bounty.wei).toString(), usdMicros: usdMicros.toString(), payoutTx, claimantWallet: user.wallet },
      // The ETH already left the treasury; a failed audit write must not fail the response.
    }).catch((err: unknown) => logger.error({ err, bountyId: bounty.id }, "bounty payout audit write failed"));
    await publishEvent(bounty.appId, {
      type: "BOUNTY_CLAIMED",
      bountyId: bounty.id,
      amountWei: big(bounty.wei).toString(),
      claimant: user.wallet as Address,
    });
    res.json(bountyDto(paid));
  }),
);
