import type { Request, Response } from "express";
import { prisma } from "@pyre/db";
import { holderInfo } from "../holder.js";
import type { HostContext } from "../resolve.js";
import { currentUser } from "../session.js";

/** `GET /_pyre/me` — session user, holder tier and the products this user has already paid for. */
export async function meRoute(ctx: HostContext, req: Request, res: Response): Promise<void> {
  const user = await currentUser(req, ctx.app.id);
  const [holder, purchases] = await Promise.all([
    holderInfo(ctx, user?.wallet),
    user
      ? prisma.purchase.findMany({
          where: {
            appId: ctx.app.id,
            userId: user.id,
            status: "PAID",
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { productId: true },
          distinct: ["productId"],
        })
      : Promise.resolve([]),
  ]);
  res.json({
    user: user ? { id: user.id, wallet: user.wallet, displayName: user.displayName } : null,
    holder,
    purchases: purchases.map((p) => p.productId),
  });
}
