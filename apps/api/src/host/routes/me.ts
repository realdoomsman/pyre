import type { Request, Response } from "express";
import { holderInfo } from "../holder.js";
import type { HostContext } from "../resolve.js";
import { currentUser } from "../session.js";

/** `GET /_pyre/me` — session user and holder tier. */
export async function meRoute(ctx: HostContext, req: Request, res: Response): Promise<void> {
  const user = await currentUser(req, ctx.app.id);
  const holder = await holderInfo(ctx, user);
  res.json({
    user: user ? { id: user.id, wallet: user.wallet, displayName: user.displayName } : null,
    holder,
  });
}
