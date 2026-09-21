import { useEffect, useState } from "react";
import { explorerAddressUrl } from "@pyre/shared";
import { useAuth } from "../../auth/useAuth.js";
import { connectWallet, discoverWallets, getWalletClient, type WalletOption } from "../../lib/wallet.js";
import { formatEth, shortAddress } from "../../lib/format.js";
import { Address, Button, toast } from "../../ui/index.js";

/**
 * External-wallet stake: send exactly `wei` to the treasury from a connected EIP-6963 wallet on
 * chain 4663, then hand the hash to the API, which verifies the transfer on-chain.
 *
 * Loaded lazily by `StepReview`: this is the only part of the launch flow that needs
 * `lib/wallet.ts`, and the custodial path must not pay for viem's wallet stack.
 */
export const ExternalStake = ({ to, wei, busy, onSent }: { to: string; wei: bigint; busy: boolean; onSent: (txHash: `0x${string}`) => void }) => {
  const auth = useAuth();
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [connected, setConnected] = useState<{ address: `0x${string}`; provider: WalletOption["provider"] } | null>(
    auth.externalWallet ? { address: auth.externalWallet.address, provider: auth.externalWallet.provider } : null,
  );
  const [sending, setSending] = useState(false);
  const [manual, setManual] = useState("");

  useEffect(() => {
    if (connected) return;
    let alive = true;
    void discoverWallets().then((w) => alive && setWallets(w));
    return () => {
      alive = false;
    };
  }, [connected]);

  const connect = async (w: WalletOption) => {
    try {
      const address = await connectWallet(w.provider);
      setConnected({ address, provider: w.provider });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Wallet connection was refused.");
    }
  };

  const send = async () => {
    if (!connected) return;
    setSending(true);
    try {
      const client = await getWalletClient(connected.provider, connected.address);
      const hash = await client.sendTransaction({ to: to as `0x${string}`, value: wei } as Parameters<typeof client.sendTransaction>[0]);
      toast.success("Stake sent", { description: shortAddress(hash, 8) });
      onSent(hash);
    } catch (e) {
      toast.error(e instanceof Error ? e.message.split("\n")[0] : "The wallet did not send the transaction.");
    } finally {
      setSending(false);
    }
  };

  const manualOk = /^0x[0-9a-fA-F]{64}$/.test(manual.trim());

  return (
    <div className="flex flex-col gap-4 rounded-card border border-line p-4">
      <div className="flex flex-col gap-1 text-14">
        <span className="text-ink-2">
          Send exactly <span className="num text-ink">{formatEth(wei)}</span> on Robinhood Chain to the treasury:
        </span>
        <Address address={to} chars={8} explorerUrl={explorerAddressUrl(to)} label="treasury" className="text-13" />
      </div>
      {connected ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="small text-ink-3">
            From <span className="num text-ink">{shortAddress(connected.address, 6)}</span>
          </span>
          <Button size="lg" loading={sending || busy} onClick={send}>
            Send {formatEth(wei)} &amp; launch
          </Button>
        </div>
      ) : wallets === null ? (
        <span className="small text-ink-3">Looking for wallets…</span>
      ) : wallets.length === 0 ? (
        <span className="small text-ink-3">No browser wallet found. Send the ETH from any wallet and paste the transaction hash below.</span>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {wallets.map((w) => (
            <li key={w.uuid}>
              <Button variant="secondary" size="sm" onClick={() => void connect(w)} iconLeft={<img src={w.icon} alt="" width={16} height={16} className="rounded-[3px]" />}>
                {w.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="small cursor-pointer text-ink-3 hover:text-ink">Already sent it? Paste the transaction hash</summary>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="num w-full min-w-0 rounded-control border border-line-2 bg-canvas px-3 py-2 text-13 text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            aria-label="Transaction hash"
          />
          <Button variant="secondary" disabled={!manualOk} loading={busy} onClick={() => onSent(manual.trim().toLowerCase() as `0x${string}`)}>
            Verify
          </Button>
        </div>
      </details>
    </div>
  );
};
