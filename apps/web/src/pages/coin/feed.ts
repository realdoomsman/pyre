import type { BuildEventDto, BuildEventPayload } from "@pyre/shared";
import { formatEth, formatTokenUnits, formatUsd, shortAddress } from "../../lib/format.js";
import type { ConsoleRow, ConsoleKind } from "../../ui/index.js";

/*
 * One event stream, two readings. The build log wants every event as a
 * terminal row colour-coded by tool; the thread wants only the moments a
 * holder cares about, phrased as a sentence.
 */

const TOOL_KIND: Record<string, ConsoleKind> = {
  read: "read",
  read_file: "read",
  cat: "read",
  ls: "read",
  glob: "read",
  edit: "edit",
  write: "edit",
  write_file: "edit",
  patch: "edit",
  search: "search",
  grep: "search",
  find: "search",
  bash: "info",
  shell: "info",
  test: "search",
};

const toolKind = (tool: string): ConsoleKind => TOOL_KIND[tool.toLowerCase()] ?? "info";

/** Console rendering of a build-log event. Chain events read as `info`, failures as `error`. */
export const consoleRow = (e: BuildEventDto): ConsoleRow => {
  const p = e.payload;
  const base = { id: e.id, at: e.createdAt } as const;
  switch (p.type) {
    case "JOB_QUEUED":
      return { ...base, kind: "info", text: `queued ${p.stage} · budget ${usd(p.budgetUsd)}` };
    case "JOB_STARTED":
      return { ...base, kind: "info", text: `started ${p.stage} on ${p.model} · sandbox ${p.sandboxId.slice(0, 8)}` };
    case "STAGE":
      return { ...base, kind: p.status === "FAIL" ? "error" : "info", text: `${p.stage} ${p.status.toLowerCase()}` };
    case "AGENT_NOTE":
      return { ...base, kind: "think", text: p.text };
    case "TOOL_CALL":
      return { ...base, kind: toolKind(p.tool), text: `${p.tool}: ${p.summary}` };
    case "COMMIT":
      return { ...base, kind: "edit", text: `commit ${p.sha.slice(0, 7)} — ${p.message}` };
    case "TEST_RESULT":
      return { ...base, kind: p.failed > 0 ? "error" : "search", text: `tests: ${p.passed} passed, ${p.failed} failed` };
    case "SCREENSHOT":
      return { ...base, kind: "info", text: `screenshot: ${p.label}` };
    case "LIGHTHOUSE":
      return { ...base, kind: "info", text: `lighthouse perf ${p.performance} · a11y ${p.accessibility} · bp ${p.bestPractices} · seo ${p.seo}` };
    case "REVIEW":
      return { ...base, kind: p.verdict === "APPROVE" ? "search" : "error", text: `review ${p.verdict.toLowerCase()}: ${p.summary}` };
    case "DEPLOY":
      return { ...base, kind: "deploy", text: `deployed v${p.version} → ${p.url}` };
    case "JOB_FINISHED":
      return { ...base, kind: "deploy", text: `finished in ${Math.round(p.durationMs / 60_000)}m · cost ${usd(p.costUsd)} · ${p.summary}` };
    case "JOB_FAILED":
      return { ...base, kind: "error", text: `failed after ${usd(p.costUsd)}: ${p.error}` };
    case "BUDGET":
      return { ...base, kind: "info", text: `budget ${p.delta >= 0 ? "+" : ""}${usd(p.delta)} → ${usd(p.budgetUsd)} (${p.reason})` };
    case "MILESTONE":
      return { ...base, kind: "deploy", text: `milestone: ${p.milestone} (${p.value})` };
    case "REVIVED":
      return { ...base, kind: "deploy", text: `relit by ${p.by} with ${usd(p.budgetUsd)}` };
    case "DORMANT":
      return { ...base, kind: "error", text: `dormant: ${p.reason}` };
    case "SELF_HEAL":
      return { ...base, kind: "error", text: `self-heal: ${p.error}` };
    case "PR_MERGED":
      return { ...base, kind: "edit", text: `merged PR #${p.prNumber} by ${p.author}` };
    case "BOUNTY_CLAIMED":
      return { ...base, kind: "info", text: `bounty ${p.bountyId.slice(0, 8)} paid ${formatEth(p.amountWei)} to ${shortAddress(p.claimant)}` };
    case "GROWTH_POST":
      return { ...base, kind: "info", text: `posted: ${p.text}` };
    case "LAUNCH":
      return { ...base, kind: "deploy", text: `launched on PONS · token ${shortAddress(p.tokenAddress)} · curve ${shortAddress(p.curveAddress)}` };
    case "LAUNCH_GATED":
      return { ...base, kind: "error", text: `launch gated: ${shortAddress(p.wallet)} cannot launch on PONS yet` };
    case "FEES":
      return { ...base, kind: "info", text: `fees claimed ${formatEth(p.wei)} (${formatUsd(p.usdMicros)}) · ${formatUsd(p.buildMicros)} to the agent` };
    case "TRADE":
      return { ...base, kind: "info", text: `${p.side.toLowerCase()} ${formatTokenUnits(p.tokenUnits)} for ${formatEth(p.quoteWei)} by ${shortAddress(p.wallet)}` };
    case "GRADUATED":
      return { ...base, kind: "deploy", text: `graduated · liquidity moved to Uniswap v4 (${p.poolId.slice(0, 10)}…)` };
  }
};

const usd = (n: number): string => formatUsd(BigInt(Math.round(n * 1e6)));

export type ThreadTone = "build" | "earn" | "burn" | "neutral" | "warn";

export interface ThreadItem {
  id: string;
  at: string;
  tone: ThreadTone;
  title: string;
  detail?: string;
  href?: string;
}

const THREAD_TYPES: Record<string, true> = {
  LAUNCH: true,
  LAUNCH_GATED: true,
  FEES: true,
  TRADE: true,
  GRADUATED: true,
  DEPLOY: true,
  MILESTONE: true,
  JOB_FINISHED: true,
  JOB_FAILED: true,
  DORMANT: true,
  REVIVED: true,
  PR_MERGED: true,
  BOUNTY_CLAIMED: true,
  GROWTH_POST: true,
  BUDGET: true,
};

export const isThreadEvent = (e: BuildEventDto): boolean => THREAD_TYPES[e.payload.type] === true;

/** Sentence form for the thread. `null` for events that only belong in the console. */
export const threadItem = (e: BuildEventDto, ticker: string, explorerTx: (hash: string) => string): ThreadItem | null => {
  const p: BuildEventPayload = e.payload;
  const base = { id: e.id, at: e.createdAt };
  switch (p.type) {
    case "LAUNCH":
      return { ...base, tone: "build", title: `$${ticker} launched on PONS`, detail: `Token ${shortAddress(p.tokenAddress)}`, href: explorerTx(p.txHash) };
    case "LAUNCH_GATED":
      return { ...base, tone: "warn", title: "Launch gated by PONS", detail: `${shortAddress(p.wallet)} is not allowed to launch yet; retrying.` };
    case "FEES":
      return { ...base, tone: "earn", title: `Creator fees claimed: ${formatEth(p.wei)}`, detail: `${formatUsd(p.buildMicros)} funded the agent`, href: explorerTx(p.txHash) };
    case "TRADE":
      return {
        ...base,
        tone: p.side === "BUY" ? "earn" : "burn",
        title: `${p.side === "BUY" ? "Bought" : "Sold"} ${formatTokenUnits(p.tokenUnits)} for ${formatEth(p.quoteWei)}`,
        detail: shortAddress(p.wallet),
        href: explorerTx(p.txHash),
      };
    case "GRADUATED":
      return { ...base, tone: "earn", title: "Graduated to Uniswap v4", detail: "The curve closed; trading continues on the pool.", href: p.txHash ? explorerTx(p.txHash) : undefined };
    case "DEPLOY":
      return { ...base, tone: "build", title: `Deployed v${p.version}`, detail: p.url, href: p.url };
    case "MILESTONE":
      return { ...base, tone: "build", title: `Milestone: ${p.milestone}`, detail: String(p.value) };
    case "JOB_FINISHED":
      return { ...base, tone: "build", title: "Build finished", detail: `${p.summary} · ${usd(p.costUsd)}` };
    case "JOB_FAILED":
      return { ...base, tone: "warn", title: "Build failed", detail: p.error };
    case "DORMANT":
      return { ...base, tone: "neutral", title: "Agent went dormant", detail: p.reason };
    case "REVIVED":
      return { ...base, tone: "build", title: "Agent relit", detail: `${p.by} added ${usd(p.budgetUsd)}` };
    case "PR_MERGED":
      return { ...base, tone: "build", title: `Merged PR #${p.prNumber}`, detail: `by ${p.author}`, href: p.url };
    case "BOUNTY_CLAIMED":
      return { ...base, tone: "earn", title: `Bounty paid: ${formatEth(p.amountWei)}`, detail: `to ${shortAddress(p.claimant)}` };
    case "GROWTH_POST":
      return { ...base, tone: "neutral", title: "Posted an update", detail: p.text, href: p.url };
    case "BUDGET":
      return { ...base, tone: p.delta >= 0 ? "earn" : "neutral", title: `Budget ${p.delta >= 0 ? "+" : ""}${usd(p.delta)}`, detail: p.reason };
    default:
      return null;
  }
};

export interface Deployment {
  id: string;
  version: number;
  url: string;
  at: string;
}

/** DEPLOY events, newest first. */
export const deployments = (events: ReadonlyArray<BuildEventDto>): Deployment[] => {
  const out: Deployment[] = [];
  for (const e of events) if (e.payload.type === "DEPLOY") out.push({ id: e.id, version: e.payload.version, url: e.payload.url, at: e.createdAt });
  out.reverse();
  return out;
};
