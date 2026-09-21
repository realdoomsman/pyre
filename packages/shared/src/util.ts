export const WEI_PER_ETH = 1_000_000_000_000_000_000n;

/** Display-precision ETH for `wei` (a double keeps ~16 significant digits; never feed the result back into money math). */
export const weiToEth = (w: bigint | number | string): number => Number(BigInt(w)) / 1e18;

/**
 * Wei for a user-entered ETH amount. A double cannot address all 18 decimals, so the value is
 * taken at 15 significant digits (which is all it ever carried) and then scaled exactly, so
 * `ethToWei(0.1)` is `10n ** 17n` and not `100000000000000006n`.
 */
export const ethToWei = (eth: number): bigint => {
  if (!Number.isFinite(eth)) throw new RangeError(`invalid ETH amount: ${eth}`);
  return decimalToUnits(eth.toPrecision(15), 18);
};

/**
 * Exact decimal-string → base-units conversion (`"1.5"`, `"2.5e-3"`, `"1e+21"`), truncating digits
 * past `decimals`. Used for ETH (18) and USDG (6) form inputs alike.
 */
export const decimalToUnits = (s: string, decimals: number): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s.trim());
  if (!m) throw new RangeError(`invalid decimal: ${s}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  const digits = BigInt(int + frac);
  const shift = Number(exp) - frac.length + decimals;
  const abs = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  return sign === "-" ? -abs : abs;
};

/** Display-precision USD value of `wei` at `ethPriceUsd`. */
export const usdFromWei = (wei: bigint | number | string, ethPriceUsd: number): number => weiToEth(wei) * ethPriceUsd;

/** `"1,234.5678 ETH"` — grouped, at most `maxFractionDigits` decimals, no trailing zeros. */
export const formatEth = (wei: bigint | number | string, maxFractionDigits = 4): string =>
  `${weiToEth(wei).toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits })} ETH`;

/* ─────────────────────────── Links ─────────────────────────── */

export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
export const PONS_URL = "https://www.ponsfamily.com";

/** The coin's page on PONS ("Trade on PONS" deep link). */
export const ponsUrl = (token: string): string => `${PONS_URL}/launchpad/${token}`;
export const explorerTxUrl = (hash: string, base = EXPLORER_URL): string => `${base}/tx/${hash}`;
export const explorerAddressUrl = (address: string, base = EXPLORER_URL): string => `${base}/address/${address}`;
export const explorerTokenUrl = (token: string, base = EXPLORER_URL): string => `${base}/token/${token}`;

/* ─────────────────────────── Slugs ─────────────────────────── */

/**
 * Slug used for `<slug>.pyre.fun` and `/a/<slug>`, so the result must be a valid
 * RFC 1123 DNS label: the hyphen trim runs AFTER the length clamp, because
 * truncating mid-word can otherwise re-introduce a trailing hyphen and break
 * certificate issuance for the app's subdomain. Combining marks are dropped so
 * "Über Café" becomes "uber-cafe" rather than "u-ber-cafe".
 */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "") || "app";

export const RESERVED_SLUGS: Record<string, true> = {
  www: true,
  api: true,
  app: true,
  admin: true,
  pyre: true,
  ship: true,
  static: true,
  assets: true,
  mail: true,
  docs: true,
  status: true,
  cdn: true,
  dev: true,
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const formatUsd = (n: number): string =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 10_000
      ? `$${(n / 1000).toFixed(1)}k`
      : `$${n.toFixed(2)}`;

export const shortAddr = (a: string, n = 4) => (a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);

/** Deterministic app-scoped derivation index from a cuid — used for per-app HD wallet indexes. */
export const fnv1a32 = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};
