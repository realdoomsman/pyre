import type { Request, Response } from "express";
import { cacheKey, cached, APPS_TAG, appTag } from "../../lib/cache.js";
import { HttpError, parse } from "../../lib/errors.js";
import { sendCached } from "../../lib/http.js";
import { CandleQuery, ListQuery, coinCandles, coinSummary, listApps } from "../../routes/apps.js";
import type { HostContext } from "../resolve.js";

/**
 * Live coin data for apps, same origin as the app so no CORS or keys are involved:
 *   GET /_pyre/coins?sort=&limit=&cursor=&q=   → the public feed page (AppsPageDto)
 *   GET /_pyre/coins/:slug                     → { app: AppSummaryDto }
 *   GET /_pyre/coins/:slug/candles?interval=&limit= → CandlesDto
 * Read-only mirrors of the platform's public endpoints, cached the same way.
 */
export async function coinsRoute(ctx: HostContext, req: Request, res: Response, slug: string | undefined, sub: string | undefined): Promise<void> {
  void ctx;
  if (slug === undefined) {
    const q = parse(ListQuery, req.query);
    if (q.q) throw new HttpError(400, "search_not_supported_here");
    const page = await cached(cacheKey("apps.list", { sort: q.sort, cursor: q.cursor ?? null, limit: q.limit }), 10_000, () => listApps(q), [APPS_TAG]);
    sendCached(res, page, { maxAge: 10, swr: 60 });
    return;
  }
  if (sub === undefined) {
    const app = await cached(cacheKey("coins.summary", { slug }), 10_000, () => coinSummary(slug), [APPS_TAG]);
    if (!app) throw new HttpError(404, "coin_not_found");
    sendCached(res, { app }, { maxAge: 10, swr: 60 });
    return;
  }
  if (sub === "candles") {
    const q = parse(CandleQuery, req.query);
    const page = await cached(cacheKey("apps.candles", { slug, interval: q.interval, limit: q.limit }), 20_000, () => coinCandles(slug, q), (v) => (v ? [appTag(v.appId)] : [APPS_TAG]));
    if (!page) throw new HttpError(404, "coin_not_found");
    sendCached(res, page.body, { maxAge: 20, swr: 60 });
    return;
  }
  throw new HttpError(404, "unknown platform endpoint");
}
