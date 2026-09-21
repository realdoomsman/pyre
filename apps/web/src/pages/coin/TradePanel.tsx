import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseEther, parseUnits, zeroAddress, type Address } from "viem";
import type { AppDetailDto } from "@pyre/shared";
import { keys as shared } from "../../api/queries.js";
import { useAuth } from "../../auth/useAuth.js";
import { explorerTx } from "../../env.js";
import { formatEth, formatPct, formatPriceUsd, formatTokenUnits, formatUsd } from "../../lib/format.js";
import { Button, Card, Chip, Input, Sheet, Tabs, toast, cx } from "../../ui/index.js";
import { keys } from "./queries.js";
import { useCustodialQuote, useCustodialTrade } from "./queries.js";
import { balancesOf, describeError, executeExternal, fromServerQuote, quoteExternal, type Quote, type Side } from "./trade.js";

/*
 * One panel, two signers. Custodial users are quoted and executed by the
 * server (`/v1/me/quote`, `/v1/me/trade`); external wallets are quoted from
 * chain state through the RPC proxy and sign the curve / router call
 * themselves. Signed-out visitors still see live quotes.
 */

const ETH_PRESETS = ["0.01", "0.05", "0.1", "0.5"] as const;
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

const parseAmount = (side: Side, text: string): bigint | null => {
  const clean = text.trim();
  if (!clean || !/^\d*\.?\d*$/.test(clean) || clean === ".") return null;
  try {
    const v = side === "buy" ? parseEther(clean) : parseUnits(clean, 18);
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
  ethPriceUsd: number;
  initialSide?: Side;
  className?: string;
  /** Called after a trade is confirmed (the tray closes itself). */
  onTraded?: () => void;
}

export const TradePanel = ({ app, ethPriceUsd, initialSide = "buy", className, onTraded }: TradePanelProps) => {
  const auth = useAuth();
  const qc = useQueryClient();
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
  const amount = useMemo(() => parseAmount(side, text), [side, text]);

  // Balances: the server knows the custodial wallet; the chain knows the external one.
  const externalBalances = useQuery({
    queryKey: ["coin", app.slug, "wallet", external?.address ?? ""],
    queryFn: () => balancesOf(app.tokenAddress as Address, external!.address),
    enabled: !!external && !!app.tokenAddress,
    refetchInterval: 15_000,
  });
  const ethWei = external ? (externalBalances.data?.ethWei ?? null) : auth.user ? BigInt(auth.user.balances.ethWei) : null;
  const units = external
    ? (externalBalances.data?.units ?? null)
    : auth.user
      ? BigInt(auth.user.positions.find((p) => p.app.slug === app.slug)?.units ?? app.viewer?.units ?? "0")
      : null;

  // Quote whenever the inputs settle.
  useEffect(() => {
    if (!tradable || amount === null) {
      setQuote({ status: "idle" });
      return;
    }
    const id = ++seq.current;
    setQuote({ status: "loading" });
    const timer = window.setTimeout(async () => {
      try {
        let q: Quote;
        if (external || !auth.authenticated) {
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
  }, [tradable, amount, side, slippageBps, external?.address, auth.authenticated, app.slug, app.phase, app.curveAddress]);

  const setPercent = (pct: number) => {
    if (units === null) return;
    setText(trimDecimals(formatUnits((units * BigInt(pct)) / 100n, 18), 6));
  };
  const setUsd = (usd: number) => {
    if (ethPriceUsd <= 0) return;
    setText(trimDecimals((usd / ethPriceUsd).toFixed(6), 6));
  };

  const insufficient =
    amount !== null && ((side === "buy" && ethWei !== null && amount > ethWei) || (side === "sell" && units !== null && amount > units));

  const submit = async () => {
    if (quote.status !== "ready" || amount === null) return;
    setBusy(true);
    const label = side === "buy" ? `Buy $${app.ticker}` : `Sell $${app.ticker}`;
    const toastId = toast.loading(`${label} — waiting for your wallet…`);
    try {
      let hash: string;
      if (external) {
        const result = await executeExternal(app, side, quote.quote, external, (h) => {
          toast.loading(`${label} submitted`, { id: toastId, description: "Confirming on Robinhood Chain…", action: { label: "Explorer", onClick: () => window.open(explorerTx(h), "_blank") } });
        });
        hash = result.hash;
      } else {
        toast.loading(`${label} submitted`, { id: toastId, description: "Signing from your Pyre wallet…" });
        const result = await serverTrade.mutateAsync({ slug: app.slug, side, amount: amount.toString(), minOut: quote.quote.minOut.toString(), slippageBps });
        hash = result.trade.txHash;
      }
      const received = side === "buy" ? `${formatTokenUnits(quote.quote.amountOut)} $${app.ticker}` : formatEth(quote.quote.amountOut);
      toast.success(`${label} confirmed`, { id: toastId, description: `≈ ${received}`, action: { label: "Explorer", onClick: () => window.open(explorerTx(hash), "_blank") } });
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

  const q = quote.status === "ready" ? quote.quote : null;
  const outUsd = q ? (side === "buy" ? (Number(q.amountOut) / 1e18) * app.priceUsd : (Number(q.amountOut) / 1e18) * ethPriceUsd) : 0;
  const cta = !tradable
    ? app.status === "LIVE"
      ? "Trading paused"
      : "Not launched yet"
    : !auth.authenticated
      ? "Sign in to trade"
      : insufficient
        ? side === "buy"
          ? "Not enough ETH"
          : `Not enough $${app.ticker}`
        : side === "buy"
          ? `Buy $${app.ticker}`
          : `Sell $${app.ticker}`;
  const canSubmit = tradable && auth.authenticated && !insufficient && quote.status === "ready" && !busy;

  return (
    <Card as="section" aria-label="Trade" className={cx("flex flex-col gap-4", className)}>
      <Tabs items={SIDES} value={side} onChange={(s) => { setSide(s); setText(""); }} name="trade-side" variant="pill" size="sm" className="w-full [&_[role=tab]]:flex-1" />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label htmlFor="trade-amount" className="eyebrow">
            {side === "buy" ? "You pay" : "You sell"}
          </label>
          <span className="num text-12 text-ink-3">
            {ethWei === null && units === null
              ? auth.authenticated
                ? "…"
                : "sign in to see balance"
              : side === "buy"
                ? `balance ${formatEth(ethWei ?? 0n)}`
                : `balance ${formatTokenUnits(units ?? 0n)}`}
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
          suffix={side === "buy" ? "ETH" : `$${app.ticker}`}
          invalid={insufficient}
          disabled={!tradable}
          className="h-12 text-18"
        />
        <div className="flex flex-wrap gap-1.5">
          {side === "buy" ? (
            <>
              {ETH_PRESETS.map((p) => (
                <Chip key={p} size="sm" mono selected={text === p} onClick={() => setText(p)}>
                  {p} ETH
                </Chip>
              ))}
              {ethPriceUsd > 0 &&
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
            {quote.status === "loading" ? "…" : q ? (side === "buy" ? `${formatTokenUnits(q.amountOut)} $${app.ticker}` : formatEth(q.amountOut)) : "—"}
          </span>
        </div>
        {q && (
          <dl className="num mt-2 space-y-1 text-12 text-ink-2">
            <Row k="≈ USD" v={formatUsd(BigInt(Math.round(outUsd * 1e6)))} />
            <Row k="Min. received" v={side === "buy" ? formatTokenUnits(q.minOut) : formatEth(q.minOut)} />
            <Row k="Fees" v={formatEth(q.feeWei)} />
            <Row k="Price impact" v={`${q.priceImpactPct >= 0 ? "" : "−"}${Math.abs(q.priceImpactPct).toFixed(2)}%`} warn={Math.abs(q.priceImpactPct) > 5} />
            <Row k="Venue" v={q.venue === "CURVE" ? "PONS curve" : "Uniswap v4"} />
            {q.refundWei > 0n && <Row k="Refund" v={`${formatEth(q.refundWei)} (curve fills to graduation)`} />}
          </dl>
        )}
        {q && q.snipeTaxBps > 0 && (
          <p className="mt-2 rounded-control border border-[color-mix(in_oklab,var(--color-warn)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)] px-2.5 py-1.5 text-12 text-warn">
            Early-buy snipe tax: {formatPct(q.snipeTaxBps / 10_000, 2)} of this buy goes to the curve. It decays over the launch window.
          </p>
        )}
        {quote.status === "error" && <p className="mt-2 text-12 text-danger">{quote.message}</p>}
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
          {formatPriceUsd(app.priceUsd)} · {external ? "signing with your wallet" : auth.authenticated ? "signed by your Pyre wallet" : "live quote"}
        </span>
        {app.ponsUrl && (
          <a href={app.ponsUrl} target="_blank" rel="noreferrer" className="hover:text-ink">
            Trade on PONS ↗
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
export const MobileTradeBar = ({ app, ethPriceUsd }: { app: AppDetailDto; ethPriceUsd: number }) => {
  const [open, setOpen] = useState<Side | null>(null);
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
      <Sheet open={open !== null} onClose={() => setOpen(null)} side="bottom" title={`Trade $${app.ticker}`} eyebrow={app.phase >= 2 ? "Uniswap v4" : "PONS curve"}>
        {open && <TradePanel app={app} ethPriceUsd={ethPriceUsd} initialSide={open} onTraded={() => setOpen(null)} className="border-0 bg-transparent p-0" />}
      </Sheet>
    </>
  );
};
