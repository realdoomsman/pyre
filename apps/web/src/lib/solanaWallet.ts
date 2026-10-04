/*
 * Injected Solana wallets, for the one place the web asks a user to sign with their own
 * Solana key: proving the payout wallet for a PYRE refund. No adapter library — the three
 * wallets people actually use expose the same legacy provider shape (`connect`,
 * `signMessage(Uint8Array)`), and anything else that injects `window.solana` speaks it too.
 */

interface PublicKeyLike {
  toString(): string;
}

/** The subset of the injected provider every listed wallet implements. Return shapes differ by wallet. */
export interface SolanaProvider {
  publicKey?: PublicKeyLike | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: PublicKeyLike } | boolean | void>;
  signMessage(message: Uint8Array, display?: "utf8" | "hex"): Promise<{ signature: ArrayLike<number> } | ArrayLike<number>>;
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
}

export interface SolanaWalletOption {
  id: "phantom" | "solflare" | "backpack" | "injected";
  name: string;
  provider: SolanaProvider;
}

interface SolanaWindow {
  phantom?: { solana?: SolanaProvider };
  solflare?: SolanaProvider;
  backpack?: SolanaProvider;
  solana?: SolanaProvider;
}

const usable = (p: unknown): p is SolanaProvider =>
  typeof p === "object" && p !== null && "connect" in p && typeof p.connect === "function" && "signMessage" in p && typeof p.signMessage === "function";

/** Phantom, Solflare, Backpack, then a generic `window.solana` when it is none of those. */
export const detectSolanaWallets = (): SolanaWalletOption[] => {
  // Wallet extensions inject these globals; lib.dom does not know them, and `usable` checks each before use.
  const w = window as unknown as SolanaWindow;
  const found: SolanaWalletOption[] = [];
  const seen = new Set<SolanaProvider>();
  const add = (id: SolanaWalletOption["id"], name: string, p: unknown) => {
    if (!usable(p) || seen.has(p)) return;
    seen.add(p);
    found.push({ id, name, provider: p });
  };
  add("phantom", "Phantom", w.phantom?.solana);
  add("solflare", "Solflare", w.solflare);
  add("backpack", "Backpack", w.backpack);
  // Phantom and others also set `window.solana` to the same object; `seen` drops the duplicate.
  add("injected", "Solana wallet", w.solana);
  return found;
};

/** Connect and return the base58 public key. Phantom/Backpack resolve with it; Solflare sets `provider.publicKey`. */
export const connectSolana = async (provider: SolanaProvider): Promise<string> => {
  const res = await provider.connect();
  const key = (typeof res === "object" && res !== null && "publicKey" in res ? res.publicKey : null) ?? provider.publicKey;
  if (!key) throw new Error("The Solana wallet returned no account.");
  return key.toString();
};

/** ed25519 signature over the UTF-8 bytes of `message`, as the 64 raw bytes. */
export const signSolanaMessage = async (provider: SolanaProvider, message: string): Promise<Uint8Array> => {
  const res = await provider.signMessage(new TextEncoder().encode(message), "utf8");
  // Phantom resolves `{ signature }`; Solflare and Backpack resolve the bytes, sometimes as a Buffer or plain array.
  const bytes = Uint8Array.from("signature" in res ? res.signature : res);
  if (bytes.length !== 64) throw new Error(`The Solana wallet returned a ${bytes.length}-byte signature, expected 64.`);
  return bytes;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
