import type { AppSummaryDto, LaunchDraftDto, MeDto } from "@pyre/shared";
import { LAUNCH_PHASE } from "@pyre/shared";

export interface CoinDraft {
  name: string;
  ticker: string;
  imageUrl: string;
  prompt: string;
  twitter: string;
  website: string;
}

export const EMPTY_DRAFT: CoinDraft = { name: "", ticker: "", imageUrl: "", prompt: "", twitter: "", website: "" };

/**
 * The exact home-feed card, fed from what the user has typed so far. Numbers are zero because
 * nothing has happened yet — the card shows the coin as it will look the second it is live.
 */
export const previewApp = (draft: CoinDraft, launch: LaunchDraftDto | undefined, me: MeDto | null): AppSummaryDto => {
  const now = new Date().toISOString();
  return {
    id: launch?.id ?? "preview",
    slug: launch?.slug ?? "preview",
    name: draft.name || launch?.name || "Your coin",
    ticker: (draft.ticker || launch?.ticker || "TICKER").toUpperCase(),
    imageUrl: draft.imageUrl || launch?.imageUrl || "",
    oneLiner: launch?.spec?.oneLiner ?? (draft.prompt.trim() || "What the agent will build, in one sentence."),
    status: launch?.status ?? "DRAFT",
    tokenAddress: launch?.tokenAddress ?? null,
    curveAddress: launch?.curveAddress ?? null,
    poolId: null,
    phase: LAUNCH_PHASE.CURVE,
    progress: 0,
    priceUsd: 0,
    mcapUsd: 0,
    change24hPct: null,
    volume24hUsd: 0,
    holders: 0,
    budgetMicros: "0",
    feesWei: "0",
    heat: 0,
    agentState: "idle",
    liveVersion: 0,
    liveUrl: null,
    template: launch?.spec?.template ?? launch?.template ?? "WEB_TOOL",
    launcher: {
      id: me?.user.id ?? "you",
      displayName: me?.user.displayName ?? "you",
      avatarUrl: me?.user.avatarUrl ?? null,
      wallet: me?.wallet ?? null,
      xHandle: me?.user.xHandle ?? null,
    },
    createdAt: launch?.createdAt ?? now,
    launchedAt: null,
    graduatedAt: null,
    ponsUrl: null,
    explorerUrl: null,
  };
};
