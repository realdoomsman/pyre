/**
 * Model pricing, matched by model-name prefix (longest prefix wins).
 *
 * `input` and `output` are USD per million tokens, which is numerically the same
 * as micros per token — so token counts multiply the price directly below.
 * `cacheRead` is NOT a price: it is the FRACTION of the input price charged for a
 * cache read (10%, or 2.5% on Fable). Cache writes cost 125% of input.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.025 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};
const CACHE_WRITE_MULTIPLIER = 1.25;
/** Unknown models are billed at the most expensive tier so budgets can never be under-charged. */
const FALLBACK = PRICES["claude-fable-5-1"]!;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const costMicrosFor = (model: string, usage: Usage): bigint => {
  let price = FALLBACK;
  let matched = -1;
  for (const key in PRICES) {
    if (model.startsWith(key) && key.length > matched) {
      matched = key.length;
      price = PRICES[key]!;
    }
  }
  // $/MTok == micros per token, so token counts multiply the price directly.
  const micros =
    usage.inputTokens * price.input +
    usage.cacheCreationInputTokens * price.input * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadInputTokens * price.input * price.cacheRead +
    usage.outputTokens * price.output;
  return BigInt(Math.ceil(micros));
};
