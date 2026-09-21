import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AppSort, AppSummaryDto } from "@pyre/shared";
import { flatPages, useApps, useStats } from "../../api/queries.js";
import { AppCard } from "../../components/AppCard.js";
import { AppPreview, useLatestScreenshot } from "../../components/AppPreview.js";
import { appUrl } from "../../env.js";
import { useTheme } from "../../lib/theme.js";
import { formatEth, formatUsd, timeAgo } from "../../lib/format.js";
import { Avatar, Button, Chip, EmptyState, HeatGauge, ProofStrip, Skeleton, Tabs, cx } from "../../ui/index.js";

type Category = "ALL" | AppSummaryDto["template"];
type Sort = Extract<AppSort, "revenue" | "burning" | "new">;

const CATEGORIES: ReadonlyArray<{ id: Category; label: string }> = [
  { id: "ALL", label: "All" },
  { id: "WEB_TOOL", label: "Tools" },
  { id: "GAME", label: "Games" },
  { id: "AGENT_API", label: "Agent APIs" },
];

const SORTS: ReadonlyArray<{ id: Sort; label: string }> = [
  { id: "revenue", label: "Revenue" },
  { id: "burning", label: "Burn" },
  { id: "new", label: "New" },
];

export const AppStore = () => {
  const [category, setCategory] = useState<Category>("ALL");
  const [sort, setSort] = useState<Sort>("revenue");
  const stats = useStats();
  const apps = useApps(sort);
  const navigate = useNavigate();
  useTheme("light");

  useEffect(() => {
    document.title = "Apps that pay to burn — Pyre";
  }, []);

  const all = useMemo(() => flatPages(apps.data?.pages), [apps.data]);
  const filtered = useMemo(() => (category === "ALL" ? all : all.filter((a) => a.template === category)), [all, category]);
  const live = filtered.filter((a) => a.status === "LIVE");
  const ash = filtered.filter((a) => a.status === "DORMANT");
  // The featured app is the top earner regardless of the active sort, so the editorial row stays put.
  const featured = useMemo(() => [...all].filter((a) => a.status === "LIVE" && a.liveUrl).sort((a, b) => Number(BigInt(b.revenueMicros) - BigInt(a.revenueMicros)))[0], [all]);

  const s = stats.data;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10">
      <header className="flex flex-col gap-5">
        <h1 className="h1 max-w-3xl">
          Apps that pay to <em>burn</em>.
        </h1>
        <p className="body max-w-2xl text-ink-2">
          Every app here was built by an agent funded by its coin's trading fees. What the app earns buys that coin back and destroys it. Open one, pay for it if it is worth
          paying for, and watch the supply shrink.
        </p>
        {s ? (
          <ProofStrip
            items={[
              { id: "live", label: "apps live", value: s.appsLive },
              { id: "rev", label: "revenue 30d", value: Number(BigInt(s.revenue30dMicros)) / 1e6, prefix: "$", format: { maximumFractionDigits: 0 } },
              { id: "burn", label: "burned 30d", value: Number(BigInt(s.burnedEth30dWei)) / 1e18, suffix: " ETH", format: { maximumFractionDigits: 3 } },
            ]}
          />
        ) : (
          <Skeleton className="h-8 w-80" />
        )}
      </header>

      {featured && <Featured app={featured} />}

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Category">
            {CATEGORIES.map((c) => (
              <Chip key={c.id} selected={category === c.id} onClick={() => setCategory(c.id)}>
                {c.label}
              </Chip>
            ))}
          </div>
          <Tabs name="apps-sort" variant="pill" size="sm" items={SORTS} value={sort} onChange={setSort} />
        </div>

        {apps.isPending ? (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i}>
                <Skeleton className="h-72" rounded="card" />
              </li>
            ))}
          </ul>
        ) : live.length === 0 ? (
          <EmptyState
            title={all.length === 0 ? "No apps are live yet" : "Nothing in this category yet"}
            body={all.length === 0 ? "The first coin to accrue $50 of fees gets the first agent. Launch one." : "Try another category, or launch the first one."}
            action={
              <Button variant="secondary" size="sm" onClick={() => navigate("/launch")}>
                Launch a coin
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {live.map((a) => (
              <li key={a.id}>
                <AppCard app={a} />
              </li>
            ))}
          </ul>
        )}

        {apps.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="secondary" loading={apps.isFetchingNextPage} onClick={() => void apps.fetchNextPage()}>
              More apps
            </Button>
          </div>
        )}
      </section>

      {ash.length > 0 && (
        <section className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between">
            <h2 className="h2">Ash</h2>
            <span className="small text-ink-3">Out of budget. A buy relights the agent.</span>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ash.map((a) => (
              <li key={a.id}>
                <AshCard app={a} onRelight={() => navigate(`/c/${a.slug}`)} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

/** Editorial row: the top-earning app with its one-liner set in the display face. */
const Featured = ({ app }: { app: AppSummaryDto }) => {
  const shot = useLatestScreenshot(app.slug);
  const url = app.liveUrl ?? appUrl(app.slug);
  return (
    <section className="grid gap-6 rounded-card border border-line bg-surface p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10">
      <div className="flex flex-col justify-between gap-6">
        <div className="flex flex-col gap-4">
          <div className="eyebrow">Featured · top revenue</div>
          <p className="display text-28 leading-tight text-ink sm:text-36">
            <em>{app.oneLiner}</em>
          </p>
          <div className="flex items-center gap-3">
            <Avatar src={app.imageUrl} name={app.ticker} size={32} shape="square" />
            <span className="text-15 font-medium text-ink">{app.name}</span>
            <Chip mono size="sm">
              ${app.ticker}
            </Chip>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-4 text-13">
          <div>
            <dt className="eyebrow">Revenue · all time</dt>
            <dd className="num text-15 text-earn">{formatUsd(BigInt(app.revenueMicros), 0)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Burned</dt>
            <dd className="num text-15 text-burn">{formatEth(app.buybackWei)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Heat</dt>
            <dd>
              <HeatGauge value={app.heat} size={56} />
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {app.liveUrl && (
            <Button href={url} target="_blank" rel="noreferrer noopener">
              Open app ↗
            </Button>
          )}
          <Button variant="secondary" href={`/c/${app.slug}`}>
            View coin
          </Button>
        </div>
      </div>
      <a href={url} target="_blank" rel="noreferrer noopener" className="group relative block overflow-hidden rounded-card border border-line" aria-label={`Open ${app.name}`}>
        {shot.isPending ? <Skeleton className="aspect-[16/10] w-full" /> : <AppPreview app={app} screenshot={shot.data} />}
        <span className="absolute inset-0 transition-colors duration-(--duration-ui) group-hover:bg-[color-mix(in_oklab,var(--color-accent)_8%,transparent)]" aria-hidden />
      </a>
    </section>
  );
};

/**
 * Ash & Relight: a dormant app, desaturated. The relight itself — funding the agent again by
 * buying or topping up — happens on the coin page.
 */
const AshCard = ({ app, onRelight }: { app: AppSummaryDto; onRelight: () => void }) => (
  <article className={cx("flex h-full flex-col gap-3 rounded-card border border-dashed border-line bg-surface p-4")}>
    <div className="ash flex items-center gap-3">
      <Avatar src={app.imageUrl} name={app.ticker} size={36} shape="square" />
      <div className="min-w-0">
        <div className="truncate text-15 font-medium text-ink-2">{app.name}</div>
        <div className="num text-12 text-ink-3">${app.ticker}</div>
      </div>
    </div>
    <p className="small ash line-clamp-2 text-ink-3">{app.oneLiner}</p>
    <dl className="grid grid-cols-2 gap-3 text-12">
      <div>
        <dt className="eyebrow">Earned before it cooled</dt>
        <dd className="num text-ink-2">{formatUsd(BigInt(app.revenueMicros), 0)}</dd>
      </div>
      <div>
        <dt className="eyebrow">Last live</dt>
        <dd className="num text-ink-2">v{app.liveVersion} · {timeAgo(app.launchedAt)}</dd>
      </div>
    </dl>
    <div className="mt-auto">
      <Button variant="secondary" size="sm" onClick={onRelight} iconLeft={<span className="h-1.5 w-1.5 rounded-pill bg-accent" aria-hidden />}>
        Relight
      </Button>
    </div>
  </article>
);
