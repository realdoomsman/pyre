import type { AgentState, AppDetailDto, AppStatusDto } from "@pyre/shared";
import { explorerToken } from "../../env.js";
import { formatCount, formatPct, formatPriceUsd, formatUsdCompact, timeAgo } from "../../lib/format.js";
import { Address, Avatar, Button, Chip, GraduationRing, HeatGauge, NumberFlow, TickFlash, cx, type ChipTone } from "../../ui/index.js";

const STATUS: Record<AppStatusDto, { label: string; tone: ChipTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SPEC_READY: { label: "Spec ready", tone: "neutral" },
  AWAITING_STAKE: { label: "Awaiting stake", tone: "warn" },
  LAUNCHING: { label: "Launching", tone: "build" },
  LAUNCH_GATED: { label: "Launch gated", tone: "warn" },
  LIVE: { label: "Live", tone: "earn" },
  DORMANT: { label: "Dormant", tone: "neutral" },
  KILLED: { label: "Killed", tone: "burn" },
  FAILED: { label: "Failed", tone: "burn" },
};

const AGENT: Record<AgentState, { label: string; tone: ChipTone }> = {
  idle: { label: "Agent idle", tone: "neutral" },
  building: { label: "Agent building", tone: "build" },
  reviewing: { label: "Agent reviewing", tone: "build" },
  deploying: { label: "Agent deploying", tone: "build" },
  dormant: { label: "Agent dormant", tone: "neutral" },
};

export const agentChip = (state: AgentState) => (
  <Chip tone={AGENT[state].tone} dot size="sm">
    {AGENT[state].label}
  </Chip>
);

const IconExternal = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M5 2.5H2.5v7h7V7M7 2.5h2.5V5M9.5 2.5 5.5 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export interface CoinHeaderProps {
  app: AppDetailDto;
  onShare: () => void;
  onReport: () => void;
}

/** Identity row: who this coin is, where it lives on chain, and how it is doing right now. */
export const CoinHeader = ({ app, onShare, onReport }: CoinHeaderProps) => {
  const status = STATUS[app.status];
  const graduated = app.phase >= 2;
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-4">
        <GraduationRing progress={app.progress} graduated={graduated} size={64} stroke={3}>
          <Avatar src={app.imageUrl} name={app.ticker} size={54} />
        </GraduationRing>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="display text-28 sm:text-36 text-ink">
              <span className="num font-medium tracking-[-0.01em]">${app.ticker}</span>
            </h1>
            <span className="text-15 text-ink-2">{app.name}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Chip tone={status.tone} size="sm" mono>
              {status.label}
            </Chip>
            {agentChip(app.agentState)}
            {graduated ? (
              <Chip tone="earn" size="sm" mono>
                Uniswap v4
              </Chip>
            ) : (
              <Chip tone="accent" size="sm" mono>
                {formatPct(app.progress, 0)} to graduation
              </Chip>
            )}
            <Chip size="sm" mono>
              Robinhood Chain · 4663
            </Chip>
          </div>
          {app.oneLiner && <p className="small mt-2 max-w-2xl text-ink-2">{app.oneLiner}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-13 text-ink-2">
            {app.tokenAddress ? (
              <Address address={app.tokenAddress} explorerUrl={explorerToken(app.tokenAddress)} label={undefined} />
            ) : (
              <span className="num text-ink-3">not launched</span>
            )}
            {app.ponsUrl && (
              <a href={app.ponsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">
                View on PONS <IconExternal />
              </a>
            )}
            {app.socials.xAccount && (
              <a href={`https://x.com/${app.socials.xAccount.replace(/^@/, "")}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                @{app.socials.xAccount.replace(/^@/, "")} <IconExternal />
              </a>
            )}
            {app.socials.website && (
              <a href={app.socials.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                Website <IconExternal />
              </a>
            )}
            {app.socials.repoUrl && (
              <a href={app.socials.repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                Repo <IconExternal />
              </a>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Avatar src={app.launcher.avatarUrl} name={app.launcher.displayName ?? "launcher"} size={16} />
              <span className="truncate">{app.launcher.displayName ?? "anonymous launcher"}</span>
              <span className="num text-ink-3">· {timeAgo(app.launchedAt ?? app.createdAt)}</span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 self-start">
          <Button variant="secondary" size="sm" onClick={onShare}>
            Share
          </Button>
          <Button variant="icon" size="sm" label="Report this coin" title="Report this coin" onClick={onReport}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path d="M3 12.5V2.5h7.5l-1.5 2.5 1.5 2.5H3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
          </Button>
        </div>
      </div>
      <Hero app={app} />
    </header>
  );
};

/** The one number: market cap as an odometer, with its 24h move flashing beneath. */
const Hero = ({ app }: { app: AppDetailDto }) => {
  const delta = app.change24hPct;
  const up = (delta ?? 0) >= 0;
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div>
        <div className="eyebrow">Market cap</div>
        <TickFlash value={app.mcapUsd} as="div" className="-mx-1 inline-block px-1">
          <NumberFlow value={app.mcapUsd} format={{ style: "currency", currency: "USD", maximumFractionDigits: 0 }} className="figure figure-hero text-ink" />
        </TickFlash>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-13">
          <span className={cx("num font-medium", delta == null ? "text-ink-3" : up ? "text-earn" : "text-burn")}>
            {delta == null ? "— 24h" : `${up ? "▲" : "▼"} ${Math.abs(delta).toFixed(2)}% 24h`}
          </span>
          <TickFlash value={app.priceUsd}>
            <span className="num text-ink-2">{formatPriceUsd(app.priceUsd)} / token</span>
          </TickFlash>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Stat label="24h volume" value={formatUsdCompact(BigInt(Math.round(app.volume24hUsd * 1e6)))} />
        <Stat label="Holders" value={formatCount(app.holders)} />
        <Stat label="Burned" value={formatPct(app.burnedPct / 100, 2)} tone="burn" />
        <div>
          <dt className="eyebrow">Heat</dt>
          <dd className="mt-1">
            <HeatGauge value={app.heat} size={72} />
          </dd>
        </div>
      </dl>
    </div>
  );
};

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "burn" | "earn" }) => (
  <div>
    <dt className="eyebrow">{label}</dt>
    <dd className={cx("num mt-1 text-15 font-medium", tone === "burn" ? "text-burn" : tone === "earn" ? "text-earn" : "text-ink")}>{value}</dd>
  </div>
);
