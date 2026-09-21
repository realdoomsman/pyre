import { MARKET_SNAPSHOT_KEY, MarketSnapshot } from "@pyre/shared";
import { cached } from "./cache.js";
import { logger } from "./logger.js";
import { db } from "./metrics.js";

/** Public read paths serve the snapshot from this cache; the runner refreshes the row every 60 s. */
export const MARKET_SNAPSHOT_TTL_MS = 30_000;

/**
 * Platform market figures (ETH/USD, $PYRE on-chain state) as the runner last persisted them to
 * `PlatformSetting`. Read through the two-tier cache with a 30 s TTL and NEVER from the RPC or a
 * price feed: a cold `/v1/stats` or app page costs one indexed row, not a chain round trip. Null
 * until the runner's first price pass (or when the row is unparseable), so callers degrade to
 * "not yet" instead of failing.
 */
export const marketSnapshot = (): Promise<MarketSnapshot | null> =>
  cached("market.snapshot", MARKET_SNAPSHOT_TTL_MS, async () => {
    const row = await db.platformSetting.findUnique({ where: { key: MARKET_SNAPSHOT_KEY } });
    if (!row) return null;
    const parsed = MarketSnapshot.safeParse(row.value);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "market snapshot row is unparseable; serving none");
      return null;
    }
    return parsed.data;
  });
