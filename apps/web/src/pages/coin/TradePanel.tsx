import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits, zeroAddress, type Address } from "viem";
import type { AppDetailDto } from "@pyre/shared";
import { venueOf } from "@pyre/shared";
import { keys as shared } from "../../api/queries.js";
import { useAuth } from "../../auth/useAuth.js";
import { formatNative, formatPct, formatPriceUsd, formatTokenUnits, formatUsd, nativeToNumber } from "../../lib/format.js";
import { useVenueLinks } from "../../lib/venue.js";
import { Button, Card, Chip, Input, Sheet, Tabs, toast, cx } from "../../ui/index.js";
import { keys } from "./queries.js";
import { useCustodialQuote, useCustodialTrade } from "./queries.js";
import { balancesOf, describeError, executeExternal, fromServerQuote, quoteExternal, type Quote, type Side } from "./trade.js";

/*
 * One panel, two signers, two venues. Custodial users are quoted and executed
 * by the server (`/v1/me/quote`, `/v1/me/trade`) on either chain. External
 * wallets only sign on Robinhood Chain: they are quoted from chain state
 * through the RPC proxy and sign the curve / router call themselves; on a
 * Solana coin they are pointed at pump.fun instead. Signed-out visitors see
 * live quotes on Robinhood Chain (chain reads need no account).
 */

const NATIVE_PRESETS: Record<string, readonly string[]> = {
  ETH: ["0.01", "0.05", "0.1", "0.5"],
  SOL: ["0.1", "0.5", "1", "5"],
};
const USD_PRESETS = [10, 50, 100] as const;
const SELL_PRESETS = [25, 50, 75, 100] as const;
const SLIPPAGE = [
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1%" },
  { bps: 300, label: "3%" },
] as const;
const QUOTE_DEBOUNCE_MS = 280;

const SIDES = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
] as const;

type QuoteState = { status: "idle" } | { status: "loading" } | { status: "ready"; quote: Quote } | { status: "error"; message: string };

const parseAmount = (text: string, decimals: number): bigint | null => {
  const clean = text.trim();
  if (!clean || !/^\d*\.?\d*$/.test(clean) || clean === ".") return null;
  try {
    const v = parseUnits(clean, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
};

const trimDecimals = (s: string, max: number): string => {
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, max).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i!;
};

export interface TradePanelProps {
  app: AppDetailDto;
  /** USD price of the app's native asset (ETH or SOL). */
  nativePriceUsd: number;
  initialSide?: Side;
  className?: string;
  /** Called after a trade is confirmed (the tray closes itself). */
  onTraded?: () => void;
}

export const TradePanel = ({ app, nativePriceUsd, initialSide = "buy", className, onTraded }: TradePanelProps) => {
  const auth = useAuth();
  const qc = useQueryClient();
  const venue = venueOf(app);
  const links = useVenueLinks(app);
  const native = venue.native;
  const solana = venue.chain === "solana";
  const external = auth.externalWallet;
  const [side, setSide] = useState<Side>(initialSide);
  const [text, setText] = useState("");
  const [slippageBps, setSlippage] = useState<number>(100);
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const serverQuote = useCustodialQuote();
  const serverTrade = useCustodialTrade(app.slug);
  const seq = useRef(0);

  const tradable = app.status === "LIVE" && !!app.tokenAddress && !!app.curveAddress && (app.phase === 0 || app.phase === 2);
  const amount = useMemo(() => parseAmount(text, side === "buy" ? native.decimals : venue.tokenDecimals), [text, side, native.decimals, venue.tokenDecimals]);
  // Who quotes and signs: the chain (external wallet or signed-out) on Robinhood, the server for a custodial user anywhere.
  const chainSigner = !solana && (!!external || !auth.authenticated);

  // Balances: the server knows the custodial wallets; the chain knows the external one.
  const externalBalances = useQuery({
    queryKey: ["coin", app.slug, "wallet", external?.address ?? ""],
    queryFn: () => balancesOf(app.tokenAddress as Address, external!.address),
    enabled: !!external && !!app.tokenAddress && !solana,
    refetchInterval: 15_000,
  });
  const nativeUnits = chainSigner ? (externalBalances.data?.ethWei ?? null) : auth.user ? BigInt(solana ? auth.user.balances.solLamports : auth.user.balances.ethWei) : null;
  const units = chainSigner
    ? (externalBalances.data?.units ?? null)
    : auth.user
      ? BigInt(auth.user.positions.find((p) => p.app.slug === app.slug)?.units ?? app.viewer?.units ?? "0")
      : null;

  // Quote whenever the inputs settle.
  useEffect(() => {
    if (!tradable || amount === null || (solana && !auth.authenticated)) {
      setQuote({ status: "idle" });
      return;
    }
    const id = ++seq.current;
    setQuote({ status: "loading" });
    const timer = window.setTimeout(async () => {
      try {
        let q: Quote;
        if (chainSigner) {
          q = await quoteExternal(app, side, amount, slippageBps, external?.address ?? zeroAddress);
        } else {
          q = fromServerQuote(await serverQuote.mutateAsync({ slug: app.slug, side, amount: amount.toString(), slippageBps }));
        }
        if (seq.current === id) setQuote({ status: "ready", quote: q });
      } catch (e) {
        if (seq.current === id) setQuote({ status: "error", message: describeError(e) });
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // serverQuote is a stable mutation handle; `app` identity changes on every refetch and must not re-quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradable, amount, side, slippageBps, chainSigner, external?.address, auth.authenticated, app.slug, app.phase, app.curveAddress]);

  const setPercent = (pct: number) => {
    if (units === null) return;
    setText(trimDecimals(formatUnits((units * BigInt(pct)) / 100n, venue.tokenDecimals), 6));
  };
  const setUsd = (usd: number) => {
    if (nativePriceUsd <= 0) return;
    setText(trimDecimals((usd / nativePriceUsd).toFixed(6), 6));
  };

  const insufficient =
    amount !== null && ((side === "buy" && nativeUnits !== null && amount > nativeUnits) || (side === "sell" && units !== null && amount > units));

  const submit = async () => {
    if (quote.status !== "ready" || amount === null) return;
    setBusy(true);
    const label = side === "buy" ? `Buy $${app.ticker}` : `Sell $${app.ticker}`;
    const toastId = toast.loading(`${label} — waiting for your wallet…`);
    try {
      let hash: string;
      if (external && !solana) {
        const result = await executeExternal(app, side, quote.quote, external, (h) => {
          toast.loading(`${label} submitted`, { id: toastId, description: "Confirming on Robinhood Chain…", action: { label: "Explorer", onClick: () => window.open(links.tx(h), "_blank") } });
        });
        hash = result.hash;
      } else {
        toast.loading(`${label} submitted`, { id: toastId, description: `Signing from your Pyre wallet on ${venue.chainLabel}…` });
        const result = await serverTrade.mutateAsync({ slug: app.slug, side, amount: amount.toString(), minOut: quote.quote.minOut.toString(), slippageBps });
        hash = result.trade.txHash;
      }
      const received = side === "buy" ? `${formatTokenUnits(quote.quote.amountOut, { decimals: venue.tokenDecimals })} $${app.ticker}` : formatNative(quote.quote.amountOut, native);
      toast.success(`${label} confirmed`, { id: toastId, description: `≈ ${received}`, action: { label: "Explorer", onClick: () => window.open(links.tx(hash), "_blank") } });
      setText("");
      setQuote({ status: "idle" });
      await Promise.all([
        auth.refresh(),
        qc.invalidateQueries({ queryKey: shared.app(app.slug) }),
        qc.invalidateQueries({ queryKey: keys.trades(app.slug) }),
        qc.invalidateQueries({ queryKey: keys.holders(app.slug) }),
        externalBalances.refetch(),
      ]);
      onTraded?.();
    } catch (e) {
      toast.error(`${label} failed`, { id: toastId, description: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  // An external-wallet session on a Solana coin: Pyre's wallet stack signs on Robinhood Chain only.
  if (solana && external) {
    return (
      <Card as="section" aria-label="Trade" className={cx("flex flex-col gap-3", className)}>
        <div className="eyebrow">Trade ${app.ticker}</div>
        <p className="text-14 text-ink-2">
          You signed in with a Robinhood Chain wallet. ${app.ticker} lives on Solana, so trade it from a Solana wallet on pump.fun — or deposit SOL to your Pyre wallet and trade here with one click.
        </p>
        <div className="flex flex-wrap gap-2">
          {app.launchpadUrl && (
            <Button href={app.launchpadUrl} target="_blank" rel="noreferrer noopener">
              Trade on pump.fun ↗
            </Button>
          )}
          <Button variant="secondary" href="/me">
            Pyre wallet
          </Button>
        </div>
        <span className="num text-12 text-ink-3">{formatPriceUsd(app.priceUsd)} · live price</span>
      </Card>
    );
  }

  const q = quote.status === "ready" ? quote.quote : null;
  const outUsd = q ? (side === "buy" ? (Number(q.amountOut) / 10 ** venue.tokenDecimals) * app.priceUsd : nativeToNumber(q.amountOut, native) * nativePriceUsd) : 0;
  const cta = !tradable
    ? app.status === "LIVE"
      ? "Trading paused"
      : "Not launched yet"
    : !auth.authenticated
      ? "Sign in to trade"
      : insufficient
        ? side === "buy"
          ? `Not enough ${native.symbol}`
          : `Not enough $${app.ticker}`
        : side === "buy"
          ? `Buy $${app.ticker}`
          : `Sell $${app.ticker}`;
  const canSubmit = tradable && auth.authenticated && !insufficient && quote.status === "ready" && !busy;
  const poolLabel = solana ? "PumpSwap" : "Uniswap v4";
  const curveLabel = solana ? "pump.fun curve" : "pons curve";

  return (
    <Card as="section" aria-label="Trade" className={cx("flex flex-col gap-4", className)}>
      <Tabs items={SIDES} value={side} onChange={(s) => { setSide(s); setText(""); }} name="trade-side" variant="pill" size="sm" className="w-full [&_[role=tab]]:flex-1" />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label htmlFor="trade-amount" className="eyebrow">
            {side === "buy" ? "You pay" : "You sell"}
          </label>
          <span className="num text-12 text-ink-3">
            {nativeUnits === null && units === null
              ? auth.authenticated
                ? "…"
                : "sign in to see balance"
              : side === "buy"
                ? `balance ${formatNative(nativeUnits ?? 0n, native)}`
                : `balance ${formatTokenUnits(units ?? 0n, { decimals: venue.tokenDecimals })}`}
          </span>
        </div>
        <Input
          id="trade-amount"
          mono
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={text}
          onChange={(e) => setText(e.target.value)}
          suffix={side === "buy" ? native.symbol : `$${app.ticker}`}
          invalid={insufficient}
          disabled={!tradable}
          className="h-12 text-18"
        />
        <div className="flex flex-wrap gap-1.5">
          {side === "buy" ? (
            <>
              {NATIVE_PRESETS[native.symbol]!.map((p) => (
                <Chip key={p} size="sm" mono selected={text === p} onClick={() => setText(p)}>
                  {p} {native.symbol}
                </Chip>
              ))}
              {nativePriceUsd > 0 &&
                USD_PRESETS.map((usd) => (
                  <Chip key={usd} size="sm" mono selected={false} onClick={() => setUsd(usd)}>
                    ${usd}
                  </Chip>
                ))}
            </>
          ) : (
            SELL_PRESETS.map((pct) => (
              <Chip key={pct} size="sm" mono selected={false} onClick={() => setPercent(pct)} disabled={units === null}>
                {pct}%
              </Chip>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">Slippage</span>
        <div className="flex gap-1">
          {SLIPPAGE.map((s) => (
            <Chip key={s.bps} size="sm" mono selected={slippageBps === s.bps} onClick={() => setSlippage(s.bps)}>
              {s.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="rounded-control border border-line bg-canvas/50 p-3" aria-live="polite">
        <div className="flex items-baseline justify-between gap-2">
          <span className="eyebrow">You receive ≈</span>
          <span className={cx("num text-15 font-medium", q ? "text-ink" : "text-ink-3")}>
            {quote.status === "loading"
              ? "…"
              : q
                ? side === "buy"
                  ? `${formatTokenUnits(q.amountOut, { decimals: venue.tokenDecimals })} $${app.ticker}`
                  : formatNative(q.amountOut, native)
                : "—"}
          </span>
        </div>
        {q && (
          <dl className="num mt-2 space-y-1 text-12 text-ink-2">
            <Row k="≈ USD" v={formatUsd(BigInt(Math.round(outUsd * 1e6)))} />
            <Row k="Min. received" v={side === "buy" ? formatTokenUnits(q.minOut, { decimals: venue.tokenDecimals }) : formatNative(q.minOut, native)} />
            <Row k="Fees" v={formatNative(q.feeWei, native)} />
            <Row k="Price impact" v={`${q.priceImpactPct >= 0 ? "" : "−"}${Math.abs(q.priceImpactPct).toFixed(2)}%`} warn={Math.abs(q.priceImpactPct) > 5} />
            <Row k="Venue" v={q.venue === "CURVE" ? curveLabel : poolLabel} />
            {q.refundWei > 0n && <Row k="Refund" v={`${formatNative(q.refundWei, native)} (curve fills to graduation)`} />}
          </dl>
        )}
        {q && q.snipeTaxBps > 0 && (
          <p className="mt-2 rounded-control border border-[color-mix(in_oklab,var(--color-warn)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)] px-2.5 py-1.5 text-12 text-warn">
            Early-buy snipe tax: {formatPct(q.snipeTaxBps / 10_000, 2)} of this buy goes to the curve. It decays over the launch window.
          </p>
        )}
        {quote.status === "error" && <p className="mt-2 text-12 text-danger">{quote.message}</p>}
        {solana && !auth.authenticated && tradable && <p className="mt-2 text-12 text-ink-3">Sign in for a live quote; Solana quotes come from your Pyre wallet.</p>}
      </div>

      {auth.authenticated || !tradable ? (
        <Button variant="primary" size="lg" className="w-full" disabled={!canSubmit} loading={busy} onClick={submit}>
          {cta}
        </Button>
      ) : (
        <Button variant="primary" size="lg" className="w-full" onClick={auth.signIn}>
          {cta}
        </Button>
      )}

      <div className="flex items-center justify-between text-12 text-ink-3">
        <span className="num">
          {formatPriceUsd(app.priceUsd)} · {external ? "signing with your wallet" : auth.authenticated ? `signed by your Pyre wallet on ${venue.chainLabel}` : "live quote"}
        </span>
        {app.launchpadUrl && (
          <a href={app.launchpadUrl} target="_blank" rel="noreferrer" className="hover:text-ink">
            Trade on {venue.launchpadLabel} ↗
          </a>
        )}
      </div>
    </Card>
  );
};

const Row = ({ k, v, warn }: { k: string; v: string; warn?: boolean }) => (
  <div className="flex justify-between gap-3">
    <dt className="text-ink-3">{k}</dt>
    <dd className={cx("text-right", warn && "text-warn")}>{v}</dd>
  </div>
);

/** Sticky bottom bar on phones: price + Buy / Sell that open the panel in a tray. */
export const MobileTradeBar = ({ app, nativePriceUsd }: { app: AppDetailDto; nativePriceUsd: number }) => {
  const [open, setOpen] = useState<Side | null>(null);
  const solana = app.chain === "solana";
  return (
    <>
      <div
        className="glass fixed inset-x-0 z-30 flex items-center gap-3 border-t border-line px-4 py-2.5 lg:hidden"
        style={{ bottom: "var(--nav-bottom, 0px)" }}
      >
        <div className="min-w-0 flex-1">
          <div className="eyebrow">${app.ticker}</div>
          <div className="num truncate text-15 font-medium text-ink">
            {formatPriceUsd(app.priceUsd)}
            <span className={cx("ml-2 text-12", (app.change24hPct ?? 0) >= 0 ? "text-earn" : "text-burn")}>
              {app.change24hPct == null ? "" : `${app.change24hPct >= 0 ? "▲" : "▼"} ${Math.abs(app.change24hPct).toFixed(1)}%`}
            </span>
          </div>
        </div>
        <Button variant="primary" size="md" onClick={() => setOpen("buy")}>
          Buy
        </Button>
        <Button variant="secondary" size="md" onClick={() => setOpen("sell")}>
          Sell
        </Button>
      </div>
      <Sheet
        open={open !== null}
        onClose={() => setOpen(null)}
        side="bottom"
        title={`Trade $${app.ticker}`}
        eyebrow={app.phase >= 2 ? (solana ? "PumpSwap" : "Uniswap v4") : solana ? "pump.fun curve" : "pons curve"}
      >
        {open && <TradePanel app={app} nativePriceUsd={nativePriceUsd} initialSide={open} onTraded={() => setOpen(null)} className="border-0 bg-transparent p-0" />}
      </Sheet>
    </>
  );
};
