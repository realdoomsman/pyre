import { useEffect, useState } from "react";
import type { Address } from "viem";
import { discoverWallets, requestAccount, signMessage, type WalletOption } from "../../lib/wallet.js";
import { Button, Skeleton } from "../../ui/index.js";
import { IconWallet } from "./IconWallet.js";

/** A connected injected wallet, with `personal_sign` bound to it so the page never imports `lib/wallet.ts` itself. */
export interface PickedEvmWallet {
  name: string;
  address: Address;
  sign: (message: string) => Promise<string>;
}

/**
 * EIP-6963 wallet list for the refund link. Loaded lazily by `LinkFlow` only when the holder
 * asks to connect, like `ExternalStake` on /launch: a visitor who only looks up an address, or
 * proves with a Pyre session, never pays for viem's wallet stack. Connecting reads the account
 * without switching networks — `personal_sign` is chain-agnostic.
 */
export const EvmWalletPicker = ({ disabled, onPick, onError }: { disabled: boolean; onPick: (w: PickedEvmWallet) => void; onError: (e: unknown) => void }) => {
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void discoverWallets().then((list) => {
      if (!cancelled) setWallets(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = async (w: WalletOption) => {
    setPending(w.uuid);
    try {
      const address = await requestAccount(w.provider);
      onPick({ name: w.name, address, sign: (message) => signMessage(w.provider, address, message) });
    } catch (e) {
      onError(e);
    } finally {
      setPending(null);
    }
  };

  if (wallets === null) return <Skeleton className="h-10 w-full sm:w-64" />;
  if (wallets.length === 0) {
    return (
      <p className="small rounded-control border border-dashed border-line px-3 py-3 text-ink-3">
        No browser wallet found. Install one that holds your Robinhood Chain address (Rabby, MetaMask, Coinbase Wallet) and reload.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {wallets.map((w) => (
        <li key={w.uuid}>
          <Button
            variant="secondary"
            className="w-full justify-start sm:w-auto"
            loading={pending === w.uuid}
            disabled={disabled || (pending !== null && pending !== w.uuid)}
            onClick={() => void pick(w)}
            iconLeft={w.icon ? <img src={w.icon} alt="" width={18} height={18} className="rounded-[4px]" /> : <IconWallet />}
          >
            Connect {w.name}
          </Button>
        </li>
      ))}
    </ul>
  );
};
