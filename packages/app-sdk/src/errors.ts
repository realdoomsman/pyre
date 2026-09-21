/** Any failure raised by the SDK. `status` is `0` for client-side failures. */
export class PyreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, opts: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "PyreError";
    this.status = opts.status ?? 0;
    this.code = opts.code ?? "pyre_error";
  }
}

/** The user has to be logged in (or the session expired). */
export class NotAuthenticatedError extends PyreError {
  constructor(message = "not authenticated") {
    super(message, { status: 401, code: "not_authenticated" });
    this.name = "NotAuthenticatedError";
  }
}

/**
 * A payment could not be completed because the user's custodial Pyre wallet is short of USDG.
 * The platform charges the wallet server-side (the wallet never needs ETH for gas), so the fix is
 * to send USDG on Robinhood Chain to `depositAddress` — there is nothing for the app to sign.
 */
export class InsufficientFundsError extends PyreError {
  /** Price of the product/function call in USD, when the platform reported it. */
  readonly priceUsd: number | null;
  /** Current USDG balance of the custodial wallet in USD, when the platform reported it. */
  readonly balanceUsd: number | null;
  /** The user's custodial Robinhood Chain address to top up with USDG, when the platform reported it. */
  readonly depositAddress: string | null;

  constructor(priceUsd: number | null = null, balanceUsd: number | null = null, depositAddress: string | null = null) {
    super("insufficient funds — top up your Pyre wallet with USDG to complete this payment", {
      status: 402,
      code: "insufficient_funds",
    });
    this.name = "InsufficientFundsError";
    this.priceUsd = priceUsd;
    this.balanceUsd = balanceUsd;
    this.depositAddress = depositAddress;
  }
}
