/**
 * Model price table, identical to the API's Anthropic proxy so that runner-side
 * calls (intake, reviewer, growth) are accounted with the same numbers.
 * USD per million tokens; cache read/write are multipliers of input price.
 */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

const PRICES: Record<string, Price> = {
  fable: { input: 10, output: 50, cacheRead: 0.025, cacheWrite: 1.25 },
  opus: { input: 5, output: 25, cacheRead: 0.1, cacheWrite: 1.25 },
  sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 1.25 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export const priceFor = (model: string): Price => {
  const m = model.toLowerCase();
  return m.includes("fable")
    ? PRICES.fable!
    : m.includes("opus")
      ? PRICES.opus!
      : m.includes("haiku")
        ? PRICES.haiku!
        : PRICES.sonnet!;
};

/** Cost in USD micros for one API call. */
export const costMicrosFor = (model: string, usage: TokenUsage): bigint => {
  const p = priceFor(model);
  const usd =
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      (usage.cache_read_input_tokens ?? 0) * p.input * p.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * p.input * p.cacheWrite) /
    1_000_000;
  return BigInt(Math.ceil(usd * 1_000_000));
};

/** Max output tokens purchasable with `usd` on `model` (output price only, floor 256). */
export const maxTokensForBudget = (model: string, usd: number, cap = 8192): number => {
  const p = priceFor(model);
  return Math.max(256, Math.min(cap, Math.floor((usd / p.output) * 1_000_000)));
};
