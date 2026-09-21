import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { FEE_SPLIT_BPS, LAUNCH_STAKE_WEI, MIN_BUILD_BUDGET_USD, MIN_BUYBACK_USD, REVENUE_SPLIT_BPS, type StatsDto } from "@pyre/shared";
import type { Format } from "@number-flow/react";
import { formatCount, formatEth, formatUsdCompact } from "../../lib/format.js";
import { useReducedMotion } from "../../lib/motion.js";
import { Button, NumberFlow, cx } from "../../ui/index.js";
import { IconArrowRight } from "../../components/icons.js";

/*
 * Below the fold for a signed-out visitor: the loop, told once, with the
 * network's real numbers docked into it. Serif headlines, one italic word,
 * lowercase-declarative copy. Nothing here animates unless the reader scrolls.
 */

interface Stage {
  id: string;
  label: string;
  copy: string;
  /** The live number for this stage, or null when the network has none yet. */
  value: (s: StatsDto) => { value: number; format?: Format; prefix?: string; suffix?: string; caption: string } | null;
}

const STAGES: ReadonlyArray<Stage> = [
  {
    id: "launch",
    label: "launch",
    copy: "describe the app. the coin launches on PONS v2 with a refundable 0.002 ETH stake.",
    value: (s) => ({ value: s.appsTotal, caption: "coins launched" }),
  },
  {
    id: "fees",
    label: "fees",
    copy: "every trade pays a 1% fee; 70% of it belongs to the coin's creator wallet — the app.",
    value: (s) => ({ value: Number(BigInt(s.feesTotalWei)) / 1e18, format: { maximumFractionDigits: 3 }, suffix: " ETH", caption: "fees claimed" }),
  },
  {
    id: "agent",
    label: "agent",
    copy: "60% of the fees fund an AI agent. at $50 it starts building; every step streams to the log.",
    value: (s) => ({ value: s.agentHoursToday, format: { maximumFractionDigits: 1 }, suffix: " h", caption: "agent-hours today" }),
  },
  {
    id: "app",
    label: "app",
    copy: "the agent ships a real app on its own subdomain, with USDG checkout built in.",
    value: (s) => ({ value: s.appsLive, caption: "apps live" }),
  },
  {
    id: "revenue",
    label: "revenue",
    copy: "people pay for the app. 85% of every dollar is earmarked for the coin.",
    value: (s) => ({ value: Number(BigInt(s.revenueTotalMicros)) / 1e6, format: { maximumFractionDigits: 0 }, prefix: "$", caption: "app revenue" }),
  },
  {
    id: "buyback",
    label: "buyback",
    copy: "every 10 minutes the treasury swaps that revenue into the coin on the curve or the v4 pool.",
    value: (s) => ({ value: s.buybacksCount, caption: "buybacks" }),
  },
  {
    id: "burn",
    label: "burn",
    copy: "the coins are burned — totalSupply falls — and an attestation tx hashes the revenue that paid for it.",
    value: (s) => ({ value: Number(BigInt(s.burnedEthWei)) / 1e18, format: { maximumFractionDigits: 3 }, suffix: " ETH", caption: "burned" }),
  },
];

/** 0–1 progress of an element through the viewport, driven by scroll. */
const useScrollProgress = (ref: RefObject<HTMLElement | null>) => {
  const [p, setP] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // Starts drawing when the top enters the lower third; done when the bottom passes the upper third.
      const start = vh * 0.66;
      const end = -r.height + vh * 0.33;
      const t = (start - r.top) / (start - end);
      setP(Math.min(1, Math.max(0, t)));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [ref]);
  return p;
};

const LoopSpine = ({ stats }: { stats: StatsDto | undefined }) => {
  const ref = useRef<HTMLOListElement>(null);
  const reduced = useReducedMotion();
  const scrolled = useScrollProgress(ref);
  const progress = reduced ? 1 : scrolled;
  const n = STAGES.length;
  return (
    <section aria-labelledby="loop-title" className="mx-auto max-w-5xl">
      <h2 id="loop-title" className="display text-36 sm:text-48">
        one loop. <em>revenue</em> closes it.
      </h2>
      <p className="body mt-3 max-w-xl text-ink-2">a coin funds an agent. the agent builds an app. the app's revenue buys the coin back and burns it. every step is a transaction you can open.</p>
      <ol ref={ref} className="relative mt-10 grid list-none gap-y-8 p-0 sm:grid-cols-[2.5rem_1fr]">
        {/* The spine: a hairline that draws with scroll, heat rising behind it. */}
        <div className="pointer-events-none absolute left-[11px] top-2 bottom-2 hidden w-px bg-line sm:block" aria-hidden>
          <div
            className="w-px origin-top bg-[linear-gradient(to_bottom,var(--heat-1),var(--heat-2),var(--heat-3),var(--heat-4))]"
            style={{ height: `${progress * 100}%`, transition: reduced ? "none" : "height 120ms linear" }}
          />
        </div>
        {STAGES.map((st, i) => {
          const reached = progress >= (i + 0.5) / n;
          const live = stats ? st.value(stats) : null;
          return (
            <li key={st.id} className="contents">
              <div className="relative hidden sm:block">
                <span
                  className={cx(
                    "absolute left-[6px] top-1.5 h-[11px] w-[11px] rounded-pill border transition-[background-color,border-color,box-shadow] duration-(--duration-reveal) ease-(--ease-reveal)",
                    reached ? "border-accent bg-accent shadow-[0_0_12px_color-mix(in_oklab,var(--color-accent)_60%,transparent)]" : "border-line-2 bg-canvas",
                  )}
                  aria-hidden
                />
              </div>
              <div className={cx("grid gap-4 transition-opacity duration-(--duration-reveal) sm:grid-cols-[1fr_auto]", reached ? "opacity-100" : "opacity-60")}>
                <div>
                  <div className="eyebrow">{`0${i + 1}`} · {st.label}</div>
                  <p className="body mt-1 max-w-lg text-ink">{st.copy}</p>
                </div>
                <div className="sm:text-right">
                  {live ? (
                    <>
                      <NumberFlow value={reached ? live.value : 0} format={live.format} prefix={live.prefix} suffix={live.suffix} className="figure figure-lg text-ink" />
                      <div className="eyebrow mt-1">{live.caption}</div>
                    </>
                  ) : (
                    <span className="num text-13 text-ink-3">—</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

const HOW: ReadonlyArray<{ title: string; body: string }> = [
  { title: "launch", body: "name, ticker, image, one paragraph about the app. the coin launches on PONS v2 from its own wallet." },
  { title: "fund", body: "trading fees claim into that wallet. 60% becomes the agent's budget; the build starts at $50." },
  { title: "ship", body: "the agent writes, tests and deploys the app. you can read every tool call as it happens." },
  { title: "burn", body: "app revenue swaps into the coin and burns it. supply falls; the tx and the attestation are public." },
];

const pct = (bps: number) => `${bps / 100}%`;

const FAQ: ReadonlyArray<{ q: string; a: ReactNode }> = [
  { q: "is a buyback a payout?", a: "no. nothing is paid to holders. the treasury buys the coin with app revenue and burns it — totalSupply falls. that is the whole mechanism." },
  {
    q: "who holds the keys?",
    a: "sign in with google and pyre keeps a custodial wallet for you (server-signed). sign in with your own wallet and you sign your own trades. the app's wallet is derived from the platform seed and only ever launches, sweeps and claims.",
  },
  { q: "what if the app never earns?", a: "then nothing is bought back. fees still fund the agent until the budget runs out; the app goes dormant and can be relit by anyone who tops up the budget." },
  { q: "where do the fees come from?", a: "PONS v2 charges 1% per trade on the curve and in the v4 pool. 70% of that is paid to the creator wallet, which is the app. pyre never takes a cut of trades." },
  { q: "can i verify any of this?", a: "every claim, buyback and burn is a transaction on robinhood chain. the burn ledger links each one. the attestation tx carries sha256 of the revenue events that paid for it." },
  { q: "is this financial advice?", a: "no. coins are not investments. apps can fail. market cap is a fact we display, never a claim we make." },
];

const Faq = () => (
  <section aria-labelledby="faq-title" className="mx-auto max-w-3xl">
    <h2 id="faq-title" className="display text-28 sm:text-36">
      the questions that <em>matter</em>
    </h2>
    <div className="mt-6 divide-y divide-line border-y border-line">
      {FAQ.map((f) => (
        <details key={f.q} className="group">
          <summary className="flex cursor-pointer list-none items-center gap-3 py-4 text-15 font-medium text-ink [&::-webkit-details-marker]:hidden">
            <span className="flex-1">{f.q}</span>
            <span className="text-ink-3 transition-transform duration-(--duration-ui) group-open:rotate-45" aria-hidden>
              +
            </span>
          </summary>
          <p className="body pb-5 text-ink-2">{f.a}</p>
        </details>
      ))}
    </div>
  </section>
);

export const Landing = ({ stats }: { stats: StatsDto | undefined }) => (
  <div className="mt-20 flex flex-col gap-24 sm:mt-28 sm:gap-32">
    <LoopSpine stats={stats} />

    <section aria-labelledby="how-title" className="mx-auto w-full max-w-5xl">
      <h2 id="how-title" className="display text-28 sm:text-36">
        how it <em>works</em>
      </h2>
      <ol className="mt-6 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {HOW.map((h, i) => (
          <li key={h.title} className="rounded-card border border-line bg-surface p-5">
            <div className="eyebrow">0{i + 1}</div>
            <h3 className="h3 mt-2 text-ink">{h.title}</h3>
            <p className="small mt-2 text-ink-2">{h.body}</p>
          </li>
        ))}
      </ol>
    </section>

    <section aria-labelledby="econ-title" className="mx-auto w-full max-w-5xl">
      <h2 id="econ-title" className="display text-28 sm:text-36">
        the <em>numbers</em>, fixed in code
      </h2>
      <div className="mt-6 overflow-hidden rounded-card border border-line">
        <table className="w-full text-13">
          <caption className="sr-only">Economics constants</caption>
          <thead>
            <tr className="eyebrow bg-surface text-left">
              <th className="px-4 py-2.5 font-medium">stream</th>
              <th className="px-4 py-2.5 font-medium">split</th>
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">where it goes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <tr>
              <td className="px-4 py-3 text-ink">creator fees (ETH)</td>
              <td className="num px-4 py-3 text-ink">
                {pct(FEE_SPLIT_BPS.BUILD_BUDGET)} / {pct(FEE_SPLIT_BPS.PYRE_TOKEN)} / {pct(FEE_SPLIT_BPS.LAUNCHER)}
              </td>
              <td className="hidden px-4 py-3 text-ink-2 sm:table-cell">agent budget / $PYRE buyback / launcher</td>
            </tr>
            <tr>
              <td className="px-4 py-3 text-ink">app revenue (USDG)</td>
              <td className="num px-4 py-3 text-ink">
                {pct(REVENUE_SPLIT_BPS.BUYBACK_BURN)} / {pct(REVENUE_SPLIT_BPS.PYRE_TOKEN)} / {pct(REVENUE_SPLIT_BPS.PLATFORM_OPS)}
              </td>
              <td className="hidden px-4 py-3 text-ink-2 sm:table-cell">buyback + burn / $PYRE buyback / platform ops</td>
            </tr>
            <tr>
              <td className="px-4 py-3 text-ink">launch stake</td>
              <td className="num px-4 py-3 text-ink">{formatEth(LAUNCH_STAKE_WEI)}</td>
              <td className="hidden px-4 py-3 text-ink-2 sm:table-cell">refunded at the first build; spam control only</td>
            </tr>
            <tr>
              <td className="px-4 py-3 text-ink">PONS trade fee</td>
              <td className="num px-4 py-3 text-ink">1% · 70% to creator</td>
              <td className="hidden px-4 py-3 text-ink-2 sm:table-cell">the creator wallet is the app's wallet</td>
            </tr>
            <tr>
              <td className="px-4 py-3 text-ink">thresholds</td>
              <td className="num px-4 py-3 text-ink">
                ${MIN_BUILD_BUDGET_USD} build · ${MIN_BUYBACK_USD} buyback
              </td>
              <td className="hidden px-4 py-3 text-ink-2 sm:table-cell">first build starts at $50 budget; buybacks batch at $5 pending revenue</td>
            </tr>
          </tbody>
        </table>
      </div>
      {stats && (
        <p className="num mt-3 text-12 text-ink-3">
          right now: {formatCount(stats.appsLive)} apps live · {formatUsdCompact(stats.revenueTotalMicros)} revenue · {formatEth(stats.burnedEthWei)} burned. not financial advice.
        </p>
      )}
    </section>

    <Faq />

    <section aria-labelledby="cta-title" className="mx-auto w-full max-w-3xl rounded-card border border-line bg-surface p-8 text-center sm:p-12">
      <h2 id="cta-title" className="display text-36 sm:text-48">
        launch a coin that <em>ships</em>.
      </h2>
      <p className="body mx-auto mt-3 max-w-md text-ink-2">describe the app in a paragraph. the stake is 0.002 ETH and comes back.</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" size="lg" href="/launch" iconRight={<IconArrowRight size={16} />}>
          Launch
        </Button>
        <Link to="/burns" className="inline-flex h-12 items-center rounded-pill px-5 text-15 font-medium text-ink-2 hover:bg-fill hover:text-ink">
          read the burn ledger
        </Link>
      </div>
    </section>
  </div>
);
