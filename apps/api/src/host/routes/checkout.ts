import type { Request, Response } from "express";
import type { Address } from "viem";
import { z } from "zod";
import { prisma } from "@pyre/db";
import { custodialUsdgBalance } from "../../lib/custodial.js";
import { HttpError, parse } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { readJson } from "../body.js";
import { chargeUsdg, sendInsufficientFunds } from "../payments.js";
import type { HostContext } from "../resolve.js";
import { recordRevenue } from "../revenue.js";
import { currentUser } from "../session.js";

const StartBody = z.object({ productId: z.string().min(1).max(40) });

const SUBSCRIPTION_DAYS = 30;

/**
 * `POST /_pyre/checkout` — charges the product price in USDG from the caller's custodial wallet to
 * the treasury (EIP-3009 authorization signed server-side, relayed by the treasury) and records the
 * already-PAID purchase. The browser never builds or signs a transaction and the wallet needs no ETH.
 */
export async function checkoutStart(ctx: HostContext, req: Request, res: Response): Promise<void> {
  const user = await currentUser(req, ctx.app.id);
  if (!user) throw new HttpError(401, "sign in required");
  if (!user.wallet) throw new HttpError(503, "wallet is not ready yet");
  const wallet = user.wallet as Address;
  const body = parse(StartBody, await readJson(req));
  const product = ctx.deployment?.manifest.products.find((p) => p.id === body.productId);
  if (!product) throw new HttpError(404, "unknown product");
  const priceMicros = BigInt(Math.round(product.priceUsd * 1e6));
  if (priceMicros <= 0n) throw new HttpError(400, "product price is zero");

  const balance = await custodialUsdgBalance(wallet);
  if (balance < priceMicros) {
    sendInsufficientFunds(res, priceMicros, balance, wallet);
    return;
  }

  const expiresAt =
    product.kind === "SUBSCRIPTION_MONTHLY" ? new Date(Date.now() + SUBSCRIPTION_DAYS * 86_400_000) : null;
  const purchase = await prisma.purchase.create({
    data: {
      appId: ctx.app.id,
      userId: user.id,
      productId: product.id,
      kind: product.kind,
      usdMicros: priceMicros,
      payerWallet: wallet,
      status: "PENDING",
    },
    select: { id: true },
  });

  let txHash: string;
  try {
    txHash = await chargeUsdg(user, priceMicros);
  } catch (err) {
    logger.error({ err, purchaseId: purchase.id, appId: ctx.app.id }, "host: checkout payment failed");
    await prisma.purchase
      .update({ where: { id: purchase.id }, data: { status: "FAILED" } })
      .catch(() => undefined);
    throw new HttpError(502, "payment_failed");
  }

  await prisma.purchase.update({
    where: { id: purchase.id },
    data: { status: "PAID", txHash, paidAt: new Date(), expiresAt },
  });
  await recordRevenue({
    app: { id: ctx.app.id, slug: ctx.app.slug },
    source: product.kind === "SUBSCRIPTION_MONTHLY" ? "SUBSCRIPTION" : "CHECKOUT",
    usdMicros: priceMicros,
    payer: wallet,
    reference: txHash,
    purchaseId: purchase.id,
    label: `checkout: ${product.id}`,
  });
  res.json({ ok: true, purchase: { status: "PAID", expiresAt, txHash } });
}
