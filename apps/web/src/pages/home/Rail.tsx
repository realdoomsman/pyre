import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import type { AppSummaryDto, AppsPageDto } from "@pyre/shared";
import { flatPages, useApps, useBurns } from "../../api/queries.js";
import { LiveTape, useTape, type TapeRow } from "../../components/LiveTape.js";
import { useLiveFrames } from "../../layout/LiveContext.js";
import { formatEth, formatTokenUnits, formatUsdCompact, timeAgo } from "../../lib/format.js";
import { Avatar, Skeleton, cx } from "../../ui/index.js";

const MiniList = ({ title, href, apps, right, tone }: { title: string; href: string; apps: AppSummaryDto[] | undefined; right: (a: AppSummaryDto) => string; tone: "burn" | "earn" }) => (
  <section className="rounded-card border border-line bg-surface" aria-label={title}>
    <header className="flex h-9 items-center justify-between border-b border-line px-3">
      <span className="eyebrow">{title}</span>
      <Link to={href} className="text-12 text-ink-3 hover:text-ink">
        all
      </Link>
    </header>
    {apps === undefined ? (
      <div className="space-y-2 p-3" aria-busy>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
    ) : apps.length === 0 ? (
      <p className="num px-3 py-6 text-center text-12 text-ink-3">nothing yet</p>
    ) : (
      <ol className="m-0 list-none p-1">
        {apps.map((a, i) => (
          <li key={a.id}>
            <Link to={`/c/${a.slug}`} className="flex items-center gap-2 rounded-control px-2 py-1.5 transition-colors duration-(--duration-ui) hover:bg-fill">
              <span className="num w-3 text-12 text-ink-3">{i + 1}</span>
              <Avatar src={a.imageUrl} name={a.ticker} size={22} />
              <span className="num min-w-0 flex-1 truncate text-13 text-ink">${a.ticker}</span>
              <span className={cx("num shrink-0 text-12", tone === "burn" ? "text-burn" : "text-earn")}>{right(a)}</span>
            </Link>
          </li>
        ))}
      </ol>
    )}
  </section>
);

/** Live tape, the five hottest coins, the five coins shipping right now. */
export const Rail = () => {
  const { rows, push, setPaused, seed: seedTape } = useTape();
  const state = useLiveFrames(push);
  const heating = useApps("heating");
  const shipping = useApps("shipping");
  const burns = useBurns();

  // Seed the tape with the newest PYRE burns so it is not blank on arrival.
  const seed = burns.data?.pages[0]?.items;
  useEffect(() => {
    if (!seed || seed.length === 0) return;
    const seeded: TapeRow[] = seed.slice(0, 12).map((b) => ({
      id: `seed:${b.id}`,
      at: b.createdAt,
      slug: "pyre",
      ticker: "PYRE",
      kind: "burn",
      amount: formatTokenUnits(b.burnedUnits),
      detail: formatEth(b.ethWei),
      href: "/burns",
    }));
    seedTape((prev) => (prev.length === 0 ? seeded : prev));
  }, [seed, seedTape]);

  const top5 = (data: { pages: AppsPageDto[] } | undefined) => (data ? flatPages(data.pages).slice(0, 5) : undefined);
  const heatingTop = useMemo(() => top5(heating.data), [heating.data]);
  const shippingTop = useMemo(() => top5(shipping.data), [shipping.data]);

  return (
    <aside className="flex flex-col gap-4" aria-label="Live">
      <LiveTape rows={rows} live={state === "open"} onPause={setPaused} height={320} />
      <MiniList title="heating up" href="/?sort=heating" apps={heatingTop} tone="burn" right={(a) => `${Math.round(a.heat * 100)}°`} />
      <MiniList title="shipping now" href="/?sort=shipping" apps={shippingTop} tone="earn" right={(a) => formatUsdCompact(a.budgetMicros)} />
      {seed && seed[0] && (
        <p className="num px-1 text-12 text-ink-3">
          last PYRE burn {timeAgo(seed[0].createdAt)} · {burns.data?.pages[0]?.totals.burns ?? 0} burns total
        </p>
      )}
    </aside>
  );
};
