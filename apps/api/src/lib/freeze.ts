import { HttpError } from "./errors.js";

/**
 * Global money freeze. `PAYOUTS_FROZEN=1` makes every route that can move value out of the
 * treasury or a custodial wallet refuse with 503 before it touches a key, while the read-only
 * site keeps working. Set during an incident; cleared only after the cause is fixed.
 */
export const payoutsFrozen = (): boolean => process.env.PAYOUTS_FROZEN === "1";

export const assertPayoutsAllowed = (): void => {
  if (payoutsFrozen()) throw new HttpError(503, "payouts_frozen", { reason: "payouts are temporarily disabled" });
};
