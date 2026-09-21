import { z } from "zod";

const CACHE_MS = 30_000;
const TIMEOUT_MS = 8_000;

const LlamaPrices = z.object({ coins: z.record(z.object({ price: z.number().positive() })) });
const CoinbaseSpot = z.object({ data: z.object({ amount: z.string(), base: z.literal("ETH"), currency: z.literal("USD") }) });

let cached: { price: number; at: number } | undefined;
let inflight: Promise<number> | undefined;

async function fetchLlama(): Promise<number> {
  const res = await fetch("https://coins.llama.fi/prices/current/coingecko:ethereum", { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`defillama ${res.status}`);
  const price = LlamaPrices.parse(await res.json()).coins["coingecko:ethereum"]?.price;
  if (price === undefined) throw new Error("defillama: no ethereum price");
  return price;
}

async function fetchCoinbase(): Promise<number> {
  const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const price = Number(CoinbaseSpot.parse(await res.json()).data.amount);
  if (!(price > 0)) throw new Error("coinbase: bad ETH price");
  return price;
}

/** ETH/USD, cached 30 s and single-flighted. DeFiLlama first, Coinbase spot as fallback; throws if both fail. */
export async function getEthPriceUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.price;
  inflight ??= (async () => {
    try {
      let price: number;
      try {
        price = await fetchLlama();
      } catch (primary) {
        try {
          price = await fetchCoinbase();
        } catch (fallback) {
          throw new Error(`ETH price unavailable: ${(primary as Error).message}; ${(fallback as Error).message}`);
        }
      }
      cached = { price, at: Date.now() };
      return price;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}
