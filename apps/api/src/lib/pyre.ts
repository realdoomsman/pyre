import { getPrice, getTokenInfo, readLaunch, type LaunchRecord, type PriceSnapshot, type TokenInfo } from "@pyre/chain";
import { env } from "../env.js";
import { cached } from "./cache.js";
import { logger } from "./logger.js";

export interface PyreTokenSnapshot {
  launch: LaunchRecord;
  price: PriceSnapshot;
  info: TokenInfo;
}

/**
 * On-chain snapshot of $PYRE (a PONS v2 launch made from the treasury), or null before it is
 * launched (`PYRE_TOKEN` unset) or while the chain is unreachable — the pages degrade to "not yet"
 * rather than failing. Cached across instances: every stats and $PYRE page read shares it.
 */
export const pyreTokenSnapshot = (): Promise<PyreTokenSnapshot | null> => {
  const token = env.PYRE_TOKEN;
  if (!token) return Promise.resolve(null);
  return cached(`pyre.token:${token}`, 30_000, async () => {
    try {
      const launch = await readLaunch(token);
      if (!launch.exists) return null;
      const [price, info] = await Promise.all([getPrice(launch), getTokenInfo(token)]);
      return { launch, price, info };
    } catch (err) {
      logger.warn({ err, token }, "$PYRE snapshot unavailable");
      return null;
    }
  });
};
