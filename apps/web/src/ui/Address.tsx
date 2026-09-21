import { useMemo, useState } from "react";
import { shortAddress } from "../lib/format.js";
import { cx } from "./cx.js";

export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export interface AddressProps {
  address: string;
  /** `address` (default) or `tx` — chooses the explorer path. */
  kind?: "address" | "tx";
  chars?: number;
  /** Override the explorer link entirely; `null` hides it. */
  explorerUrl?: string | null;
  identicon?: boolean;
  copy?: boolean;
  /** Optional display label instead of the short form (e.g. "treasury"). */
  label?: string;
  className?: string;
}

/*
 * Identicon: an 8×8 mirrored grid seeded from the address, in the blockies
 * tradition but drawn with the house palette (three hues from the hash,
 * moderate saturation) so it sits beside ink and hairlines without shouting.
 */
const seedFrom = (s: string): number[] => {
  const seed = [0, 0, 0, 0];
  for (let i = 0; i < s.length; i++) seed[i % 4] = (seed[i % 4] << 5) - seed[i % 4] + s.charCodeAt(i);
  return seed;
};

const rng = (seed: number[]) => () => {
  const t = seed[0] ^ (seed[0] << 11);
  seed[0] = seed[1];
  seed[1] = seed[2];
  seed[2] = seed[3];
  seed[3] = seed[3] ^ (seed[3] >> 19) ^ t ^ (t >> 8);
  return (seed[3] >>> 0) / 4294967296;
};

const hsl = (rand: () => number, l: number) => `hsl(${Math.floor(rand() * 360)} ${Math.floor(rand() * 30 + 40)}% ${l}%)`;

export const identiconCells = (address: string) => {
  const rand = rng(seedFrom(address.toLowerCase()));
  const color = hsl(rand, 62);
  const bg = hsl(rand, 22);
  const spot = hsl(rand, 48);
  const cells: number[] = [];
  for (let y = 0; y < 8; y++) {
    const row = Array.from({ length: 4 }, () => Math.floor(rand() * 2.3));
    cells.push(...row, ...row.slice().reverse());
  }
  return { color, bg, spot, cells };
};

export const Identicon = ({ address, size = 16, className }: { address: string; size?: number; className?: string }) => {
  const { color, bg, spot, cells } = useMemo(() => identiconCells(address), [address]);
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" className={cx("shrink-0 rounded-[3px]", className)} aria-hidden shapeRendering="crispEdges">
      <rect width="8" height="8" fill={bg} />
      {cells.map((c, i) => (c ? <rect key={i} x={i % 8} y={Math.floor(i / 8)} width="1" height="1" fill={c === 1 ? color : spot} /> : null))}
    </svg>
  );
};

const IconCopy = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" stroke="currentColor" />
    <path d="M8 4V2.5A1 1 0 0 0 7 1.5H2.5a1 1 0 0 0-1 1V7a1 1 0 0 0 1 1H4" stroke="currentColor" />
  </svg>
);
const IconCheck = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconExternal = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M5 2.5H2.5v7h7V7M7 2.5h2.5V5M9.5 2.5 5.5 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** `0x84F8…4afA` with identicon, copy and a Blockscout link. */
export const Address = ({ address, kind = "address", chars = 4, explorerUrl, identicon = kind === "address", copy = true, label, className }: AddressProps) => {
  const [copied, setCopied] = useState(false);
  const href = explorerUrl === undefined ? `${EXPLORER_URL}/${kind}/${address}` : explorerUrl;
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied: nothing to show */
    }
  };
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)}>
      {identicon && <Identicon address={address} />}
      <span className="num text-13 text-ink" title={address}>
        {label ?? shortAddress(address, chars)}
      </span>
      {copy && (
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Copied" : `Copy ${kind}`}
          className={cx("inline-grid h-5 w-5 place-items-center rounded-[4px] transition-colors duration-(--duration-ui) hover:bg-fill", copied ? "text-earn" : "text-ink-3 hover:text-ink")}
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      )}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open ${kind} on Blockscout`}
          className="inline-grid h-5 w-5 place-items-center rounded-[4px] text-ink-3 transition-colors duration-(--duration-ui) hover:bg-fill hover:text-ink"
        >
          <IconExternal />
        </a>
      )}
    </span>
  );
};
