import { EXPLORER_URL, ROBINHOOD_CHAIN_ID } from "@pyre/shared";

const read = (key: string): string | undefined => {
  const v = (import.meta.env as Record<string, string | undefined>)[key];
  return v === undefined || v === "" ? undefined : v;
};

const origin = read("VITE_API_ORIGIN")?.replace(/\/+$/, "") ?? "";

export const env = {
  apiOrigin: origin,
  googleClientId: read("VITE_GOOGLE_CLIENT_ID") ?? "",
  /** Wildcard app host (`<slug>.pyre.fun`). Empty → path routing through the API. */
  appDomain: read("VITE_APP_DOMAIN") ?? "",
  /** The $PYRE token address once launched; empty until then. */
  pyreToken: read("VITE_PYRE_TOKEN") ?? "",
  chainId: Number(read("VITE_CHAIN_ID") ?? ROBINHOOD_CHAIN_ID),
  explorerUrl: (read("VITE_EXPLORER_URL") ?? EXPLORER_URL).replace(/\/+$/, ""),
  /** Public RPC handed to injected wallets in `wallet_addEthereumChain`; the app itself reads via `POST /v1/rpc`. */
  publicRpcUrl: read("VITE_PUBLIC_RPC_URL") ?? "https://rpc.mainnet.chain.robinhood.com",
  chainName: "Robinhood Chain",
  siteUrl: "https://pyre.fun",
} as const;

/** Public URL of a deployed app: wildcard subdomain when configured, path routing otherwise. */
export const appUrl = (slug: string): string =>
  env.appDomain ? `https://${slug}.${env.appDomain}` : `${env.apiOrigin}/a/${slug}`;

export const explorerTx = (hash: string): string => `${env.explorerUrl}/tx/${hash}`;
export const explorerAddress = (address: string): string => `${env.explorerUrl}/address/${address}`;
export const explorerToken = (token: string): string => `${env.explorerUrl}/token/${token}`;
