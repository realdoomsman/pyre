import {
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  numberToHex,
  stringToHex,
  type AddEthereumChainParameter,
  type Address,
  type EIP1193Provider,
  type Hex,
  type WalletClient,
} from "viem";
import { env } from "../env.js";
import { getConnectedWallet } from "./walletSession.js";

/*
 * Browser-side wallet plumbing for external (non-custodial) users. Nothing
 * here is imported by the entry chunk: the sign-in sheet and the trade panel
 * pull it in on demand, which keeps viem out of the initial graph.
 */

export type Eip1193Provider = EIP1193Provider;

export interface WalletOption {
  uuid: string;
  name: string;
  /** Data URI per EIP-6963. */
  icon: string;
  rdns: string;
  provider: Eip1193Provider;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

/** Robinhood Chain as a viem chain, from env so a staging chain can be pointed at. */
export const walletChain = defineChain({
  id: env.chainId,
  name: env.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.publicRpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: env.explorerUrl } },
});

const CHAIN_HEX = numberToHex(env.chainId);

/** Parameters for `wallet_addEthereumChain` (EIP-3085). */
export const addChainParams: AddEthereumChainParameter = {
  chainId: CHAIN_HEX,
  chainName: env.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [env.publicRpcUrl],
  blockExplorerUrls: [env.explorerUrl],
};

/**
 * EIP-6963 discovery: announce → collect for a short window. Wallets that
 * only expose `window.ethereum` (older extensions) are folded in as a single
 * "Injected" option so nobody is left without a button.
 */
export const discoverWallets = async (windowMs = 250): Promise<WalletOption[]> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const found = new Map<string, WalletOption>();
  const onAnnounce = (e: Event) => {
    // The EIP-6963 announce event is a CustomEvent carrying `{ info, provider }`.
    const announce = e as CustomEvent<Eip6963Detail>;
    const { info, provider } = announce.detail;
    if (!info || !provider) return;
    found.set(info.uuid, { uuid: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns, provider });
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  window.setTimeout(resolve, windowMs);
  await promise;
  window.removeEventListener("eip6963:announceProvider", onAnnounce);
  const list = [...found.values()];
  if (list.length === 0 && "ethereum" in window && window.ethereum && typeof window.ethereum === "object") {
    // Pre-6963 extensions only expose `window.ethereum`; it is an EIP-1193 provider by definition.
    const legacy = window.ethereum as Eip1193Provider;
    list.push({ uuid: "injected", name: "Injected wallet", icon: "", rdns: "injected", provider: legacy });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
};

const isRpcError = (e: unknown): e is { code: number } => typeof e === "object" && e !== null && "code" in e && typeof e.code === "number";

/** Switch the wallet to Robinhood Chain, adding it first if the wallet does not know it. */
export const ensureChain = async (provider: Eip1193Provider): Promise<void> => {
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (current.toLowerCase() === CHAIN_HEX) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    // 4902: unknown chain (MetaMask). Some wallets return -32603 with the same meaning.
    if (!isRpcError(e) || (e.code !== 4902 && e.code !== -32603)) throw e;
    await provider.request({ method: "wallet_addEthereumChain", params: [addChainParams] });
  }
  const after = (await provider.request({ method: "eth_chainId" })) as string;
  if (after.toLowerCase() !== CHAIN_HEX) throw new Error(`wallet stayed on chain ${parseInt(after, 16)}; switch to ${env.chainName}`);
};

/** Request accounts and put the wallet on Robinhood Chain. Returns the checksummed primary address. */
export const connectWallet = async (provider: Eip1193Provider): Promise<Address> => {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const first = accounts[0];
  if (!first) throw new Error("the wallet returned no account");
  await ensureChain(provider);
  return getAddress(first);
};

/** EIP-191 `personal_sign` of a UTF-8 message (sent hex-encoded, as the RPC expects); `/v1/auth/wallet/verify` checks it with viem. */
export const signMessage = (provider: Eip1193Provider, address: Address, message: string): Promise<Hex> =>
  provider.request({ method: "personal_sign", params: [stringToHex(message), address] });

export { getConnectedWallet, setConnectedWallet, type ConnectedWallet } from "./walletSession.js";

/**
 * viem wallet client bound to the external wallet on chain 4663. Defaults to
 * the wallet that signed in; pass a provider + address to sign with another.
 */
export const getWalletClient = async (provider?: Eip1193Provider, address?: Address): Promise<WalletClient> => {
  const connected = getConnectedWallet();
  const p = provider ?? connected?.provider;
  const a = address ?? connected?.address;
  if (!p || !a) throw new Error("no external wallet connected — sign in with a wallet first");
  await ensureChain(p);
  return createWalletClient({ account: a, chain: walletChain, transport: custom(p) });
};
