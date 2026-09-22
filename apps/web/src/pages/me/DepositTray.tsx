import type { Chain } from "@pyre/shared";
import { ROBINHOOD_CHAIN_ID, VENUES } from "@pyre/shared";
import { formatNative } from "../../lib/format.js";
import { useVenueLinks } from "../../lib/venue.js";
import { Address, Button, Sheet } from "../../ui/index.js";
import { Qr } from "./Qr.js";

export const BRIDGES = [
  {
    name: "Relay",
    href: "https://relay.link/bridge/robinhood",
    detail: "Seconds. From Arbitrum, Base, Ethereum and most L2s.",
  },
  {
    name: "Arbitrum canonical bridge",
    href: "https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum",
    detail: "Trustless, from Ethereum. About 10 minutes in; 7 days out.",
  },
  {
    name: "Across",
    href: "https://across.to/?to=robinhood",
    detail: "Seconds. Intent-based, from Ethereum and major L2s.",
  },
] as const;

/** The venue whose custodial wallet the tray shows; one wallet per chain. */
const VENUE_OF_CHAIN = { robinhood: VENUES.pons_v2, solana: VENUES.pump_fun } as const;

interface Props {
  open: boolean;
  onClose: () => void;
  chain: Chain;
  address: string;
  /** Present when the tray was opened because a balance fell short of a required amount (native base units). */
  short?: { needUnits: bigint; haveUnits: bigint; purpose: string };
}

/**
 * Deposit: the custodial address as text + QR, and the ways to get the chain's native asset onto
 * it. Robinhood Chain lists bridges; Solana takes a plain SOL transfer from any wallet or
 * exchange. Nothing here moves money — the user does.
 */
export const DepositTray = ({ open, onClose, chain, address, short }: Props) => {
  const venue = VENUE_OF_CHAIN[chain];
  const links = useVenueLinks(venue);
  const solana = chain === "solana";
  return (
    <Sheet
      open={open}
      onClose={onClose}
      eyebrow={solana ? "Solana" : `Robinhood Chain · ${ROBINHOOD_CHAIN_ID}`}
      title={`Deposit ${solana ? "SOL" : "ETH"}`}
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}
    >
      <div className="flex flex-col gap-5">
        {short && (
          <div className="rounded-card border border-[color-mix(in_oklab,var(--color-warn)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-warn)_8%,transparent)] px-4 py-3 text-14">
            <div className="eyebrow mb-1 text-warn">Short by {formatNative(short.needUnits - short.haveUnits, venue.native)}</div>
            <p className="text-ink-2">
              {short.purpose} needs <span className="num text-ink">{formatNative(short.needUnits, venue.native)}</span>; this wallet holds{" "}
              <span className="num text-ink">{formatNative(short.haveUnits, venue.native)}</span>.
            </p>
          </div>
        )}
        <div className="flex flex-col items-center gap-4 rounded-card border border-line bg-mono-bg p-5">
          <Qr value={address} size={168} className="rounded-control border border-line bg-white p-2" />
          <Address address={address} chars={8} explorerUrl={links.address(address)} className="text-14" />
          <p className="small text-center text-ink-3">
            {solana ? (
              <>
                Send <span className="text-ink">SOL</span> on Solana only. Not wrapped SOL, not a bridged token, not another network — assets sent any other way are not recoverable.
              </>
            ) : (
              <>
                Send <span className="text-ink">ETH</span> or <span className="text-ink">USDG</span> on Robinhood Chain only. Assets sent on another network are not recoverable.
              </>
            )}
          </p>
        </div>
        {solana ? (
          <p className="small text-ink-3">
            Any Solana wallet or an exchange withdrawal to the Solana network works. Balances update within a minute of the transfer confirming; deposits are read from the chain.
          </p>
        ) : (
          <div>
            <div className="eyebrow mb-2">Bridge to Robinhood Chain</div>
            <ul className="flex flex-col divide-y divide-line rounded-card border border-line">
              {BRIDGES.map((b) => (
                <li key={b.name}>
                  <a
                    href={b.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-(--duration-ui) ease-(--ease-ui) hover:bg-fill"
                  >
                    <span className="min-w-0">
                      <span className="block text-14 font-medium text-ink">{b.name}</span>
                      <span className="small block text-ink-3">{b.detail}</span>
                    </span>
                    <span aria-hidden className="text-ink-3">
                      ↗
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="small mt-2 text-ink-3">Balances update within a minute of the transfer confirming. Deposits are read from the chain, never from a bridge's status page.</p>
          </div>
        )}
      </div>
    </Sheet>
  );
};
