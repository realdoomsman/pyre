import type { Address, EIP1193Provider } from "viem";

/*
 * The external wallet that signed in, remembered for `getWalletClient()`.
 * Dependency-free on purpose: `auth/AuthProvider.tsx` imports this from the
 * entry graph, and viem must stay behind the lazy sign-in boundary.
 */
export interface ConnectedWallet {
  provider: EIP1193Provider;
  address: Address;
}

let connected: ConnectedWallet | null = null;

export const setConnectedWallet = (next: ConnectedWallet | null): void => {
  connected = next;
};
export const getConnectedWallet = (): ConnectedWallet | null => connected;
