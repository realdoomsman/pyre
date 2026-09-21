import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, isRouteErrorResponse, useLocation, useRouteError } from "react-router-dom";
import { isHttpError } from "../api/client.js";
import { useStats } from "../api/queries.js";
import type { GlobalFrame } from "../api/types.js";
import { Lockup, Mark } from "../components/Lockup.js";
import { IconApps, IconBurn, IconGitHub, IconHome, IconLaunch, IconPyre, IconRefresh, IconSearch, IconUser, IconX } from "../components/icons.js";
import { env } from "../env.js";
import { Button, Kbd, ProofStrip, Toaster, cx, type ProofItem } from "../ui/index.js";
import { AccountMenu } from "./AccountMenu.js";
import { LiveProvider, useLiveFrames } from "./LiveContext.js";
import { usePalette } from "./usePalette.js";

// The palette (and `motion`, which animates it) is loaded on first ⌘K, not on every page view.
const Palette = lazy(async () => ({ default: (await import("./Palette.js")).Palette }));

const NAV: ReadonlyArray<{ to: string; label: string; icon: (p: { size?: number; className?: string }) => ReactNode }> = [
  { to: "/", label: "Home", icon: IconHome },
  { to: "/apps", label: "Apps", icon: IconApps },
  { to: "/burns", label: "Burns", icon: IconBurn },
  { to: "/pyre", label: "$PYRE", icon: IconPyre },
];

const MOBILE_NAV = [...NAV.slice(0, 3), { to: "/me", label: "Me", icon: IconUser }] as const;

const GITHUB_URL = "https://github.com/realdoomsman/pyre";
const X_URL = "https://x.com/pyredotfun";

const RouteError = () => {
  const err = useRouteError();
  const status = isHttpError(err) ? err.status : isRouteErrorResponse(err) ? err.status : null;
  const msg = isHttpError(err) ? err.error : isRouteErrorResponse(err) ? (err.statusText ?? "request failed") : err instanceof Error ? err.message : "something broke";
  return (
    <div className="mx-auto mt-16 max-w-md rounded-card border border-line bg-surface p-6 animate-fade-in">
      <div className="eyebrow text-burn">{status ? `error ${status}` : "error"}</div>
      <h1 className="h2 mt-2">this page did not load</h1>
      <p className="small mt-2 break-words text-ink-2">{msg}</p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()} iconLeft={<IconRefresh size={14} />}>
          Retry
        </Button>
        <Button variant="primary" size="sm" href="/">
          Home
        </Button>
      </div>
    </div>
  );
};

/**
 * Proof Strip: three live network numbers in the nav. Seeded from
 * `/v1/stats`, nudged by SSE frames so a burn rolls the counter before the
 * next poll lands.
 */
const Proof = ({ compact }: { compact?: boolean }) => {
  const stats = useStats();
  const [nudge, setNudge] = useState({ burnedWei: 0n, live: 0 });
  useLiveFrames(
    useCallback((f: GlobalFrame) => {
      const p = f.event?.payload;
      if (!p) return;
      if (p.type === "BUYBACK") setNudge((n) => ({ ...n, burnedWei: n.burnedWei + BigInt(p.ethWei) }));
      if (p.type === "LAUNCH") setNudge((n) => ({ ...n, live: n.live + 1 }));
    }, []),
  );
  // Reset the nudges when a fresh snapshot arrives; it already includes them.
  const snapshot = stats.dataUpdatedAt;
  const items = useMemo<ProofItem[]>(() => {
    const s = stats.data;
    if (!s) return [];
    void snapshot;
    return [
      { id: "burned", label: "eth burned", value: Number(BigInt(s.burnedEthWei) + nudge.burnedWei) / 1e18, format: { minimumFractionDigits: 3, maximumFractionDigits: 3 } },
      { id: "live", label: "apps live", value: s.appsLive + nudge.live },
      { id: "hours", label: "agent-hours today", value: s.agentHoursToday, format: { maximumFractionDigits: 1 } },
    ];
  }, [stats.data, nudge, snapshot]);
  if (items.length === 0) return <span className="hidden h-4 w-56 rounded-pill bg-fill md:block" aria-hidden />;
  return <ProofStrip items={items} compact={compact} className="text-12" />;
};

const Header = ({ onSearch }: { onSearch: () => void }) => (
  <header className="sticky top-0 z-40 border-b border-line glass">
    <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 sm:px-6">
      <Link to="/" className="flex shrink-0 items-center rounded-[4px] outline-none focus-visible:outline-2 focus-visible:outline-accent" aria-label="Pyre home">
        <Lockup height={22} className="hidden sm:block" />
        <Mark size={28} className="sm:hidden" />
      </Link>

      <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === "/"}
            className={({ isActive }) =>
              cx(
                "rounded-pill px-3 py-1.5 text-14 font-medium transition-colors duration-(--duration-ui)",
                isActive ? "bg-fill text-ink" : "text-ink-2 hover:bg-fill hover:text-ink",
              )
            }
          >
            {n.label}
          </NavLink>
        ))}
      </nav>

      <div className="hidden min-w-0 flex-1 justify-center lg:flex">
        <Proof compact />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search (⌘K)"
          className="inline-flex h-9 items-center gap-2 rounded-pill border border-line-2 bg-fill px-3 text-13 text-ink-3 transition-colors duration-(--duration-ui) hover:border-line-3 hover:text-ink"
        >
          <IconSearch size={14} />
          <span className="hidden sm:inline">search</span>
          <span className="hidden sm:inline-flex">
            <Kbd keys={["⌘", "K"]} />
          </span>
        </button>
        <span className="hidden md:inline-flex">
          <Button variant="primary" size="sm" href="/launch" iconLeft={<IconLaunch size={14} />}>
            Launch
          </Button>
        </span>
        <AccountMenu />
      </div>
    </div>
  </header>
);

const Footer = () => (
  <footer className="mt-16 border-t border-line">
    <div className="mx-auto grid max-w-[1440px] gap-8 px-4 py-10 sm:grid-cols-[1.4fr_1fr_1fr] sm:px-6">
      <div>
        <Lockup height={20} />
        <p className="small mt-3 max-w-sm text-ink-2">
          coins that build apps. fees pay an agent to build the app; the app's revenue buys the coin back and{" "}
          <span className="text-ink">burns</span> it.
        </p>
        <p className="micro mt-3 max-w-sm text-ink-3">coins are not investments. apps can fail. buybacks are burns, never distributions. not financial advice.</p>
        <div className="mt-4 flex items-center gap-3">
          <span className="num inline-flex items-center gap-1.5 rounded-pill border border-line px-2.5 py-1 text-12 text-ink-2">
            <span className="h-1.5 w-1.5 rounded-pill bg-earn" aria-hidden />
            {env.chainName} · {env.chainId}
          </span>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener" aria-label="GitHub" className="text-ink-3 transition-colors hover:text-ink">
            <IconGitHub size={16} />
          </a>
          <a href={X_URL} target="_blank" rel="noreferrer noopener" aria-label="X" className="text-ink-3 transition-colors hover:text-ink">
            <IconX size={15} />
          </a>
        </div>
      </div>
      <div>
        <div className="eyebrow mb-3">product</div>
        <ul className="small space-y-2 text-ink-2">
          {[
            ["/launch", "launch a coin"],
            ["/apps", "app store"],
            ["/burns", "burn ledger"],
            ["/pyre", "$PYRE"],
            ["/governance", "governance"],
            ["/status", "status"],
          ].map(([to, label]) => (
            <li key={to}>
              <Link to={to} className="transition-colors hover:text-ink">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="eyebrow mb-3">legal</div>
        <ul className="small space-y-2 text-ink-2">
          {[
            ["/legal/terms", "terms"],
            ["/legal/privacy", "privacy"],
            ["/legal/content-policy", "content policy"],
          ].map(([to, label]) => (
            <li key={to}>
              <Link to={to} className="transition-colors hover:text-ink">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  </footer>
);

const MobileBar = ({ hideFab }: { hideFab: boolean }) => (
  <>
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line glass pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Primary (mobile)">
      <ul className="grid grid-cols-4">
        {MOBILE_NAV.map((n) => (
          <li key={n.to}>
            <NavLink
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                cx("relative flex h-14 flex-col items-center justify-center gap-1 transition-colors duration-(--duration-ui)", isActive ? "text-ink" : "text-ink-3")
              }
            >
              {({ isActive }) => (
                <>
                  <span className={cx("absolute top-0 h-0.5 w-6 rounded-pill bg-accent transition-opacity duration-(--duration-ui)", isActive ? "opacity-100" : "opacity-0")} aria-hidden />
                  <n.icon size={18} />
                  <span className="text-[11px] font-medium leading-none">{n.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
    {!hideFab && (
      <Link
        to="/launch"
        aria-label="Launch a coin"
        className="fixed right-4 z-40 inline-flex h-12 items-center gap-2 rounded-pill bg-accent px-4 text-14 font-medium text-accent-ink shadow-[0_8px_24px_rgba(0,0,0,.35)] transition-colors duration-(--duration-ui) hover:bg-accent-strong md:hidden"
        style={{ bottom: "calc(var(--nav-bottom) + 12px)" }}
      >
        <IconLaunch size={16} />
        Launch
      </Link>
    )}
  </>
);

const Frame = ({ error }: { error: boolean }) => {
  const palette = usePalette();
  const { pathname } = useLocation();
  const onCoin = pathname.startsWith("/c/");
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-pill focus:bg-accent focus:px-3 focus:py-1.5 focus:text-accent-ink">
        skip to content
      </a>
      <Header onSearch={palette.show} />
      <div className="border-b border-line lg:hidden">
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6">
          <Proof />
        </div>
      </div>
      <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 pt-5 sm:px-6" style={{ paddingBottom: "calc(var(--nav-bottom) + 2rem)" }}>
        {error ? <RouteError /> : <Outlet />}
      </main>
      <Footer />
      <MobileBar hideFab={onCoin} />
      {palette.mounted && (
        <Suspense fallback={null}>
          <Palette open={palette.open} onClose={palette.hide} />
        </Suspense>
      )}
      <Toaster />
    </div>
  );
};

/** The shell: sticky glass nav, proof strip, ⌘K, mobile bar, footer, one SSE stream for everyone below. */
export const Shell = ({ error = false }: { error?: boolean }) => (
  <LiveProvider>
    <Frame error={error} />
  </LiveProvider>
);
