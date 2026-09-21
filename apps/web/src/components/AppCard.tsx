import { Link } from "react-router-dom";
import type { AppSummaryDto } from "@pyre/shared";
import { formatCount, formatUsdCompact, timeAgo } from "../lib/format.js";
import { Avatar, Card, Chip, cx } from "../ui/index.js";
import { AGENT_CHIP } from "./CoinCard.js";
import { IconExternal } from "./icons.js";

export interface AppCardProps {
  app: AppSummaryDto;
  className?: string;
}

/**
 * App-store card: the app is the point, the coin is the consequence. Works on
 * Ash Paper (the store is light) and on the dark canvas alike — every colour
 * is a semantic token.
 */
export const AppCard = ({ app, className }: AppCardProps) => {
  const dormant = app.agentState === "dormant" || app.status === "DORMANT";
  const agent = AGENT_CHIP[app.agentState];
  return (
    <Card as="article" padding={0} interactive ash={dormant} className={cx("flex flex-col", className)} aria-label={app.name}>
      <Link to={`/c/${app.slug}`} className="flex flex-1 flex-col p-4 outline-none">
        <div className="flex items-start gap-3">
          <Avatar src={app.imageUrl} name={app.name} size={44} shape="square" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-15 font-medium text-ink">{app.name}</h2>
            <div className="num text-12 text-ink-3">
              ${app.ticker} · {app.liveUrl ? `v${app.liveVersion}` : "not deployed"} · {timeAgo(app.launchedAt ?? app.createdAt)}
            </div>
          </div>
        </div>
        <p className="mt-3 line-clamp-2 text-13 text-ink-2">{app.oneLiner}</p>
        <dl className="mt-4 grid grid-cols-3 gap-2 text-12">
          <div>
            <dt className="eyebrow">revenue</dt>
            <dd className="num text-ink">{formatUsdCompact(app.revenueMicros)}</dd>
          </div>
          <div>
            <dt className="eyebrow">24h</dt>
            <dd className="num text-earn">{formatUsdCompact(app.revenue24hMicros)}</dd>
          </div>
          <div>
            <dt className="eyebrow">holders</dt>
            <dd className="num text-ink">{formatCount(app.holders)}</dd>
          </div>
        </dl>
      </Link>
      <div className="flex items-center gap-2 border-t border-line px-4 py-2">
        <Chip tone={agent.tone} dot={agent.dot} size="sm" mono>
          {agent.label}
        </Chip>
        {app.liveUrl && (
          <a href={app.liveUrl} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-12 font-medium text-accent hover:underline">
            open app <IconExternal size={12} />
          </a>
        )}
      </div>
    </Card>
  );
};
