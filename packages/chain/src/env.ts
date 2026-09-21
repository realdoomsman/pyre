/**
 * Environment read lazily so importing the package never throws. Defaults are the public
 * Robinhood Chain endpoints; production sets RPC_URL to an Alchemy URL and BLOCKSCOUT_API_KEY
 * to a Blockscout PRO key (the public explorer sits behind a Cloudflare challenge).
 */
const DEFAULTS: Record<string, string> = {
  RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  BLOCKSCOUT_URL: "https://robinhoodchain.blockscout.com",
  USDG_ADDRESS: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};

export const optionalEnv = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
};

export const requiredEnv = (key: string): string => {
  const v = optionalEnv(key);
  if (!v) throw new Error(`${key} is not set`);
  return v;
};

/** Env value or its built-in default; throws only for keys without a default. */
export const envOr = (key: keyof typeof DEFAULTS | string): string => optionalEnv(key) ?? DEFAULTS[key] ?? requiredEnv(key);

export const rpcUrl = (): string => envOr("RPC_URL");
export const blockscoutUrl = (): string => envOr("BLOCKSCOUT_URL").replace(/\/+$/, "");
export const platformMasterSeedHex = (): string => requiredEnv("PLATFORM_MASTER_SEED_HEX");
