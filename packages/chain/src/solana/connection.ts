import { Connection, type Finality } from "@solana/web3.js";
import { optionalEnv } from "../env.js";

/**
 * Solana is an optional venue: nothing here is reachable until `SOLANA_RPC_URL` is set. Key
 * derivation and address checks are pure and always work; every network-bound call throws
 * `SolanaDisabledError` while the venue is off so a misconfigured deployment fails loudly
 * instead of hitting a public RPC.
 */
export type SolanaCluster = "mainnet-beta" | "devnet";

export const SOLANA_COMMITMENT: Finality = "confirmed";
/** Highest transaction message version this web3.js can deserialise (v1 = transaction-config messages, live since 2026). */
export const MAX_TX_VERSION = 1;

export const solanaRpcUrl = (): string | undefined => optionalEnv("SOLANA_RPC_URL");
export const solanaEnabled = (): boolean => solanaRpcUrl() !== undefined;

/** `SOLANA_CLUSTER`, default mainnet-beta. Only affects explorer links and which pump deployment is expected. */
export function solanaCluster(): SolanaCluster {
  const v = optionalEnv("SOLANA_CLUSTER") ?? "mainnet-beta";
  if (v !== "mainnet-beta" && v !== "devnet") throw new Error(`SOLANA_CLUSTER must be mainnet-beta or devnet, got ${v}`);
  return v;
}

export class SolanaDisabledError extends Error {
  constructor() {
    super("solana venue disabled: SOLANA_RPC_URL is not set");
    this.name = "SolanaDisabledError";
  }
}

let singleton: { url: string; wss: string | undefined; connection: Connection } | undefined;

/** Process-wide RPC connection at `confirmed` commitment, rebuilt if the env changes. */
export function connection(): Connection {
  const url = solanaRpcUrl();
  if (!url) throw new SolanaDisabledError();
  const wss = optionalEnv("SOLANA_WSS_URL");
  if (singleton && singleton.url === url && singleton.wss === wss) return singleton.connection;
  singleton = { url, wss, connection: new Connection(url, { commitment: SOLANA_COMMITMENT, wsEndpoint: wss, confirmTransactionInitialTimeout: 60_000 }) };
  return singleton.connection;
}
