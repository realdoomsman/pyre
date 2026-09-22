import { z } from "zod";
import { optionalEnv } from "../env.js";

const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const JupiterPrices = z.record(z.object({ usdPrice: z.number().positive() }));
const CoinGeckoSimple = z.object({ solana: z.object({ usd: z.number().positive() }) });

let cached: { price: number; at: number } | undefined;
let inflight: Promise<number> | undefined;

async function fetchJupiter(): Promise<number> {
  const key = optionalEnv("JUPITER_API_KEY");
  const res = await fetch(`https://api.jup.ag/price/v3?ids=${WSOL_MINT}`, { headers: key ? { "x-api-key": key } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`jupiter ${res.status}`);
  const price = JupiterPrices.parse(await res.json())[WSOL_MINT]?.usdPrice;
  if (price === undefined) throw new Error("jupiter: no SOL price");
  return price;
}

async function fetchCoinGecko(): Promise<number> {
  const key = optionalEnv("COINGECKO_API_KEY");
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { headers: key ? { "x-cg-demo-api-key": key } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  return CoinGeckoSimple.parse(await res.json()).solana.usd;
}

/** SOL/USD, cached 60 s and single-flighted. Jupiter price v3 first, CoinGecko as fallback; throws if both fail. */
export async function getSolPriceUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.price;
  inflight ??= (async () => {
    try {
      let price: number;
      try {
        price = await fetchJupiter();
      } catch (primary) {
        try {
          price = await fetchCoinGecko();
        } catch (fallback) {
          throw new Error(`SOL price unavailable: ${(primary as Error).message}; ${(fallback as Error).message}`);
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
