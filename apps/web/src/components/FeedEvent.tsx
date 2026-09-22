import type { ReactNode } from "react";
import type { BuildEventDto, BuildEventPayload } from "@pyre/shared";
import { formatEth, formatNative, formatTokenUnits, formatUsd, shortAddress, timeAgo, type NativeUnit } from "../lib/format.js";
import type { VenueLinks } from "../lib/venue.js";
import { Chip, type ChipTone, type ConsoleKind, type ConsoleRow, cx } from "../ui/index.js";
import { AddressLink, TxLink } from "./TxLink.js";
import { IconExternal } from "./icons.js";

/*
 * One renderer for every `BuildEventPayload` kind. Three shapes come out of the
 * same switch so cards, the console and the tape never drift:
 *   - `feedLine`   one plain sentence (cards, notifications, tape)
 *   - `consoleRow` a ConsoleFrame row (kind + text)
 *   - `FeedEvent`  the full row with links, chips and any block content
 * Chain amounts (`wei`, `quoteWei`) are in the app's native units, so every
 * shape takes the app's venue. Bounties are always ETH: they escrow from the
 * Robinhood Chain custodial wallet whatever chain the coin is on.
 */

type Payload = BuildEventPayload;

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;

export const feedLine = (p: Payload, venue: VenueLinks): string => {
  const native: NativeUnit = venue.meta.native;
  const decimals = venue.meta.tokenDecimals;
  switch (p.type) {
    case "JOB_QUEUED":
      return `queued ${p.stage.toLowerCase()} · ${usd(p.budgetUsd)} budget`;
    case "JOB_STARTED":
      return `started ${p.stage.toLowerCase()} on ${p.model}`;
    case "STAGE":
      return `${p.stage.toLowerCase()} ${p.status.toLowerCase()}`;
    case "AGENT_NOTE":
      return p.text;
    case "TOOL_CALL":
      return `${p.tool}: ${p.summary}`;
    case "COMMIT":
      return `commit ${p.sha.slice(0, 7)} — ${p.message}`;
    case "TEST_RESULT":
      return `tests: ${p.passed} passed, ${p.failed} failed`;
    case "SCREENSHOT":
      return `screenshot: ${p.label}`;
    case "LIGHTHOUSE":
      return `lighthouse perf ${p.performance} · a11y ${p.accessibility} · bp ${p.bestPractices} · seo ${p.seo}`;
    case "REVIEW":
      return `review ${p.verdict.toLowerCase()}: ${p.summary}`;
    case "DEPLOY":
      return `deployed v${p.version}`;
    case "JOB_FINISHED":
      return `finished · ${usd(p.costUsd)} · ${p.summary}`;
    case "JOB_FAILED":
      return `failed: ${p.error}`;
    case "BUDGET":
      return `budget ${p.delta >= 0 ? "+" : "−"}${usd(Math.abs(p.delta))} (${p.reason}) → ${usd(p.budgetUsd)}`;
    case "MILESTONE":
      return `milestone: ${p.milestone}`;
    case "REVIVED":
      return `relit by ${shortAddress(p.by)} · ${usd(p.budgetUsd)} budget`;
    case "DORMANT":
      return `dormant: ${p.reason}`;
    case "SELF_HEAL":
      return `self-heal: ${p.error}`;
    case "PR_MERGED":
      return `merged PR #${p.prNumber} by ${p.author}`;
    case "BOUNTY_CLAIMED":
      return `bounty ${formatEth(p.amountWei)} claimed by ${shortAddress(p.claimant)}`;
    case "GROWTH_POST":
      return `posted: ${p.text}`;
    case "LAUNCH":
      return `coin live on ${venue.meta.launchpadLabel} · ${shortAddress(p.tokenAddress)}`;
    case "LAUNCH_GATED":
      return `launch gated for ${shortAddress(p.wallet)} — ${venue.meta.launchpadLabel} not accepting launches yet`;
    case "FEES":
      return `fees claimed ${formatNative(p.wei, native)} · ${formatUsd(p.buildMicros)} to the build budget`;
    case "TRADE":
      return `${p.side.toLowerCase()} ${formatTokenUnits(p.tokenUnits, { decimals })} for ${formatNative(p.quoteWei, native)} by ${shortAddress(p.wallet)}`;
    case "GRADUATED":
      return venue.meta.chain === "solana" ? "graduated — liquidity moved to the pumpswap pool" : "graduated — liquidity moved to the uniswap v4 pool";
  }
};

const KIND: Record<Payload["type"], ConsoleKind> = {
  JOB_QUEUED: "info",
  JOB_STARTED: "info",
  STAGE: "info",
  AGENT_NOTE: "think",
  TOOL_CALL: "read",
  COMMIT: "edit",
  TEST_RESULT: "search",
  SCREENSHOT: "read",
  LIGHTHOUSE: "search",
  REVIEW: "think",
  DEPLOY: "deploy",
  JOB_FINISHED: "deploy",
  JOB_FAILED: "error",
  BUDGET: "info",
  MILESTONE: "deploy",
  REVIVED: "info",
  DORMANT: "error",
  SELF_HEAL: "error",
  PR_MERGED: "edit",
  BOUNTY_CLAIMED: "info",
  GROWTH_POST: "info",
  LAUNCH: "deploy",
  LAUNCH_GATED: "error",
  FEES: "info",
  TRADE: "info",
  GRADUATED: "deploy",
};

const TOOL_KIND: Record<string, ConsoleKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "search",
  grep: "search",
  glob: "search",
  search: "search",
  think: "think",
};

/** Only build-loop events belong in a console; chain and social events render elsewhere. */
export const isBuildEvent = (p: Payload): boolean =>
  p.type !== "TRADE" && p.type !== "FEES" && p.type !== "GROWTH_POST" && p.type !== "LAUNCH" && p.type !== "GRADUATED";

export const consoleRow = (e: BuildEventDto, venue: VenueLinks): ConsoleRow => {
  const p = e.payload;
  const kind = p.type === "TOOL_CALL" ? (TOOL_KIND[p.tool.toLowerCase()] ?? "read") : (p.type === "STAGE" && p.status === "FAIL" ? "error" : KIND[p.type]);
  return { id: e.id, at: e.createdAt, kind, text: feedLine(p, venue) };
};

const TONE: Partial<Record<Payload["type"], ChipTone>> = {
  DEPLOY: "build",
  JOB_FINISHED: "build",
  JOB_FAILED: "burn",
  DORMANT: "burn",
  LAUNCH_GATED: "warn",
  SELF_HEAL: "warn",
  FEES: "earn",
  BUDGET: "earn",
  MILESTONE: "accent",
  LAUNCH: "accent",
  GRADUATED: "accent",
  REVIVED: "accent",
  PR_MERGED: "build",
  BOUNTY_CLAIMED: "earn",
};

const LABEL: Record<Payload["type"], string> = {
  JOB_QUEUED: "queued",
  JOB_STARTED: "started",
  STAGE: "stage",
  AGENT_NOTE: "agent",
  TOOL_CALL: "tool",
  COMMIT: "commit",
  TEST_RESULT: "tests",
  SCREENSHOT: "screenshot",
  LIGHTHOUSE: "lighthouse",
  REVIEW: "review",
  DEPLOY: "deploy",
  JOB_FINISHED: "finished",
  JOB_FAILED: "failed",
  BUDGET: "budget",
  MILESTONE: "milestone",
  REVIVED: "relit",
  DORMANT: "dormant",
  SELF_HEAL: "self-heal",
  PR_MERGED: "merged",
  BOUNTY_CLAIMED: "bounty",
  GROWTH_POST: "post",
  LAUNCH: "launch",
  LAUNCH_GATED: "gated",
  FEES: "fees",
  TRADE: "trade",
  GRADUATED: "graduated",
};

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent hover:underline">
    {children}
    <IconExternal size={12} />
  </a>
);

/** Rich body for kinds that carry more than a sentence. */
const Body = ({ p, venue }: { p: Payload; venue: VenueLinks }) => {
  const native: NativeUnit = venue.meta.native;
  switch (p.type) {
    case "COMMIT":
      return (
        <>
          <span className="num text-ink-3">{p.sha.slice(0, 7)}</span> {p.message}
          {p.url && (
            <>
              {" "}
              <Ext href={p.url}>diff</Ext>
            </>
          )}
        </>
      );
    case "TEST_RESULT":
      return (
        <>
          <span className="num text-earn">{p.passed} passed</span>
          {p.failed > 0 && (
            <>
              {" · "}
              <span className="num text-burn">{p.failed} failed</span>
            </>
          )}
          {p.output && <pre className="num mt-2 max-h-40 overflow-auto rounded-control bg-mono-bg p-2 text-12 text-ink-2">{p.output}</pre>}
        </>
      );
    case "SCREENSHOT":
      return (
        <>
          {p.label}
          <a href={p.url} target="_blank" rel="noreferrer noopener" className="mt-2 block max-w-sm overflow-hidden rounded-control border border-line">
            <img src={p.url} alt={p.label} loading="lazy" decoding="async" className="block w-full" />
          </a>
        </>
      );
    case "LIGHTHOUSE":
      return (
        <span className="num inline-flex flex-wrap gap-x-3">
          <span>perf {p.performance}</span>
          <span>a11y {p.accessibility}</span>
          <span>bp {p.bestPractices}</span>
          <span>seo {p.seo}</span>
        </span>
      );
    case "REVIEW":
      return (
        <>
          <span className={p.verdict === "APPROVE" ? "text-earn" : "text-burn"}>{p.verdict.toLowerCase()}</span> — {p.summary}
          {p.findings.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-12 text-ink-2">
              {p.findings.map((f, i) => (
                <li key={i}>
                  <span className={cx("num uppercase", f.severity === "BLOCK" ? "text-burn" : f.severity === "WARN" ? "text-warn" : "text-ink-3")}>{f.severity}</span> {f.text}
                </li>
              ))}
            </ul>
          )}
        </>
      );
    case "DEPLOY":
      return (
        <>
          deployed <span className="num">v{p.version}</span> · <Ext href={p.url}>open app</Ext>
        </>
      );
    case "PR_MERGED":
      return (
        <>
          merged <Ext href={p.url}>PR #{p.prNumber}</Ext> by {p.author}
        </>
      );
    case "BOUNTY_CLAIMED":
      return (
        <>
          bounty <span className="num">{formatEth(p.amountWei)}</span> claimed by <AddressLink address={p.claimant} copy={false} />
        </>
      );
    case "GROWTH_POST":
      return (
        <>
          {p.text} <Ext href={p.url}>post</Ext>
        </>
      );
    case "REVIVED":
      return (
        <>
          relit by <AddressLink address={p.by} copy={false} /> · <span className="num">{usd(p.budgetUsd)}</span> budget
        </>
      );
    case "LAUNCH":
      return (
        <>
          coin live on <Ext href={p.launchpadUrl}>{venue.meta.launchpadLabel}</Ext> · token <AddressLink address={p.tokenAddress} venue={venue} /> · tx{" "}
          <TxLink hash={p.txHash} copy={false} venue={venue} />
        </>
      );
    case "LAUNCH_GATED":
      return (
        <>
          {venue.meta.launchpadLabel} refused <AddressLink address={p.wallet} copy={false} venue={venue} /> — launch retries automatically
        </>
      );
    case "FEES":
      return (
        <>
          claimed <span className="num text-earn">{formatNative(p.wei, native)}</span> ({formatUsd(p.usdMicros)}) · <span className="num">{formatUsd(p.buildMicros)}</span> to the build
          budget · tx <TxLink hash={p.txHash} copy={false} venue={venue} />
        </>
      );
    case "TRADE":
      return (
        <>
          <span className={cx("num uppercase", p.side === "BUY" ? "text-earn" : "text-burn")}>{p.side}</span>{" "}
          <span className="num">{formatTokenUnits(p.tokenUnits, { decimals: venue.meta.tokenDecimals })}</span> for <span className="num">{formatNative(p.quoteWei, native)}</span> by{" "}
          <AddressLink address={p.wallet} copy={false} venue={venue} /> · <TxLink hash={p.txHash} copy={false} venue={venue} />
        </>
      );
    case "GRADUATED":
      return (
        <>
          {venue.meta.chain === "solana" ? "graduated — liquidity moved to the pumpswap pool" : "graduated — liquidity moved to the uniswap v4 pool"}
          {p.txHash && (
            <>
              {" · "}
              <TxLink hash={p.txHash} copy={false} venue={venue} />
            </>
          )}
        </>
      );
    default:
      return <>{feedLine(p, venue)}</>;
  }
};

export interface FeedEventProps {
  event: BuildEventDto;
  /** The app's venue: resolves native units, token decimals and explorer links. */
  venue: VenueLinks;
  /** Compact: one line, no block content (cards, rails). */
  compact?: boolean;
  className?: string;
}

/** One feed row: label chip, body, relative time. */
export const FeedEvent = ({ event, venue, compact, className }: FeedEventProps) => {
  const p = event.payload;
  return (
    <div className={cx("flex items-start gap-3 py-2", className)}>
      <Chip tone={TONE[p.type] ?? "neutral"} size="sm" mono className="mt-0.5 w-[5.5rem] shrink-0 justify-center">
        {LABEL[p.type]}
      </Chip>
      <div className={cx("min-w-0 flex-1 text-13 text-ink-2", compact && "truncate")}>{compact ? feedLine(p, venue) : <Body p={p} venue={venue} />}</div>
      <time dateTime={event.createdAt} className="num shrink-0 text-12 text-ink-3" title={new Date(event.createdAt).toLocaleString()}>
        {timeAgo(event.createdAt)}
      </time>
    </div>
  );
};
