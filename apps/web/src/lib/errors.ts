/** Server error codes that mean "fund your custodial wallet first". */
const DEPOSIT_CODES: Record<string, true> = {
  insufficient_balance: true,
  insufficient_sol_for_fee: true,
  wallet_required: true,
};

const NICE: Record<string, string> = {
  invalid_address: "That destination address is not valid.",
  amount_too_small: "That amount is too small.",
  cannot_withdraw_to_self: "You cannot withdraw to your own wallet.",
  bounty_too_small: "That bounty is below the minimum.",
  invalid_amount: "Enter a valid amount.",
};

/**
 * Turns a custodial-action API error into a message a user can act on. Balance
 * shortfalls point them at their deposit address; other known codes get plain
 * English; anything else falls through unchanged.
 */
export const actionError = (err: unknown, wallet: string | null): string => {
  const code = err instanceof Error ? err.message : typeof err === "string" ? err : "failed";
  if (DEPOSIT_CODES[code]) {
    return wallet
      ? `Insufficient balance — deposit to your wallet ${wallet}`
      : "Insufficient balance — deposit SOL to your wallet first.";
  }
  return NICE[code] ?? code;
};
