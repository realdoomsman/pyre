// Representative sample data for capturing the real Berth product UI.
// NOT real platform earnings — illustrative fixtures so screenshots show a
// populated interface. Captions must label these as representative.

const hex = (n) => Array.from({ length: n }, (_, i) => "0123456789abcdef"[(i * 7 + 3) % 16]).join("");
const sig = (seed) => (seed + "5KJp7z9QmXn2vB4cR8tYwE3aLdFhGjKqSuVxZbNmPoIu").slice(0, 64);
const wallet = (seed) => (seed + "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM").slice(0, 44);
const iso = (minAgo) => new Date(Date.now() - minAgo * 60_000).toISOString();

const SOL = 107.94;

function summary(o) {
  return {
    id: o.id,
    slug: o.slug,
    name: o.name,
    ticker: o.ticker,
    imageUrl: "",
    status: o.status,
    template: o.template ?? "WEB_TOOL",
    oneLiner: o.oneLiner,
    mint: o.mint ?? wallet(o.ticker),
    priceUsd: o.priceUsd,
    marketCapUsd: o.marketCapUsd,
    holders: o.holders,
    users: o.users,
    revenueUsd: o.revenueUsd,
    buybackSol: o.buybackSol,
    burnedTokens: o.burnedTokens,
    priceToRevenue: o.priceToRevenue ?? null,
    budgetUsd: o.budgetUsd,
    liveVersion: o.liveVersion,
    liveUrl: o.status === "LIVE" || o.status === "DORMANT" ? `https://${o.slug}.berth.fun` : null,
    pumpUrl: `https://pump.fun/coin/${o.mint ?? wallet(o.ticker)}`,
    runningJob: o.runningJob ?? null,
    lastEvent: o.lastEvent ?? null,
    createdAt: iso(o.ageMin ?? 1440),
  };
}

const APPS = [
  summary({
    id: "app_inbox", slug: "inbox", name: "Inbox Zero", ticker: "INBOX",
    status: "LIVE", oneLiner: "One-tap unsubscribe that actually works.",
    priceUsd: 0.00291, marketCapUsd: 291_000, holders: 812, users: 2431,
    revenueUsd: 4213.55, buybackSol: 26.4, burnedTokens: 9_120_000, priceToRevenue: 69,
    budgetUsd: 30.7, liveVersion: 6, ageMin: 5040,
    lastEvent: { id: "ev_l1", appId: "app_inbox", jobId: null, type: "DEPLOY", payload: { type: "DEPLOY", version: 6, url: "https://inbox.berth.fun" }, createdAt: iso(41) },
  }),
  summary({
    id: "app_shot", slug: "shotcaller", name: "Shotcaller", ticker: "SHOT",
    status: "LIVE", oneLiner: "An odds model for your pickup basketball league.",
    priceUsd: 0.00104, marketCapUsd: 104_000, holders: 344, users: 690,
    revenueUsd: 1287.02, buybackSol: 8.1, burnedTokens: 3_400_000, priceToRevenue: 81,
    budgetUsd: 58.2, liveVersion: 4, ageMin: 3600,
    runningJob: { id: "job_shot", stage: "ITERATE", status: "RUNNING", model: "claude-sonnet", budgetUsd: 25, costUsd: 6.8, startedAt: iso(4) },
    lastEvent: { id: "ev_l2", appId: "app_shot", jobId: "job_shot", type: "TOOL_CALL", payload: { type: "TOOL_CALL", tool: "edit_file", summary: "added per-team elo drift" }, createdAt: iso(1) },
  }),
  summary({
    id: "app_tldr", slug: "tldr", name: "QuickTLDR", ticker: "TLDR",
    status: "LIVE", oneLiner: "Summarize any PDF for a dime, pay-per-call.",
    priceUsd: 0.00061, marketCapUsd: 61_000, holders: 210, users: 5120,
    revenueUsd: 512.4, buybackSol: 3.2, burnedTokens: 1_780_000, priceToRevenue: 119,
    budgetUsd: 12.4, liveVersion: 3, template: "AGENT_API", ageMin: 2880,
    lastEvent: { id: "ev_l3", appId: "app_tldr", jobId: null, type: "MILESTONE", payload: { type: "MILESTONE", milestone: "5,000 documents summarized", value: 5000 }, createdAt: iso(120) },
  }),
  summary({
    id: "app_dead", slug: "deadlinks", name: "Deadlinks", ticker: "DEAD",
    status: "LIVE", oneLiner: "Finds and fixes broken links on your whole site.",
    priceUsd: 0.00022, marketCapUsd: 22_000, holders: 96, users: 140,
    revenueUsd: 96.0, buybackSol: 0.6, burnedTokens: 410_000, priceToRevenue: 229,
    budgetUsd: 44.0, liveVersion: 2, ageMin: 1440,
    lastEvent: { id: "ev_l4", appId: "app_dead", jobId: null, type: "DEPLOY", payload: { type: "DEPLOY", version: 2, url: "https://deadlinks.berth.fun" }, createdAt: iso(300) },
  }),
  summary({
    id: "app_cron", slug: "cronbot", name: "Cronbot", ticker: "CRON",
    status: "LIVE", oneLiner: "Write a cron job in plain English.",
    priceUsd: 0.00009, marketCapUsd: 9_000, holders: 41, users: 12,
    revenueUsd: 0, buybackSol: 0, burnedTokens: 0, priceToRevenue: null,
    budgetUsd: 61.0, liveVersion: 0, ageMin: 180,
    runningJob: { id: "job_cron", stage: "SCAFFOLD", status: "RUNNING", model: "claude-sonnet", budgetUsd: 52, costUsd: 3.1, startedAt: iso(6) },
    lastEvent: { id: "ev_l5", appId: "app_cron", jobId: "job_cron", type: "STAGE", payload: { type: "STAGE", stage: "SCAFFOLD", status: "START" }, createdAt: iso(6) },
  }),
  summary({
    id: "app_one", slug: "onepager", name: "OnePager", ticker: "ONE",
    status: "DORMANT", oneLiner: "Turn a prompt into a one-page site.",
    priceUsd: 0.00004, marketCapUsd: 4_000, holders: 33, users: 58,
    revenueUsd: 34.5, buybackSol: 0.2, burnedTokens: 120_000, priceToRevenue: 116,
    budgetUsd: 0, liveVersion: 1, ageMin: 4320,
    lastEvent: { id: "ev_l6", appId: "app_one", jobId: null, type: "DORMANT", payload: { type: "DORMANT", reason: "budget reached $0" }, createdAt: iso(600) },
  }),
];

const STATS = {
  revenueUsd: APPS.reduce((s, a) => s + a.revenueUsd, 0),
  buybackSol: APPS.reduce((s, a) => s + a.buybackSol, 0),
  buybackUsd: APPS.reduce((s, a) => s + a.buybackSol, 0) * SOL,
  shipBurned: 14_300_000,
  appsLive: 5,
  appsBuilding: 2,
  appsTotal: 6,
  feesSol: 61.8,
  feesUsd: 61.8 * SOL,
  solPriceUsd: SOL,
  appsKilled: 0,
  launchesReachingBuildGate: 6,
  medianBuildCostUsd: 21.4,
  firstDeploySuccessRate: 9200,
  uptimeAvgBps: 9985,
};

const INBOX_SPEC = {
  title: "Inbox Zero",
  oneLiner: "One-tap unsubscribe that actually works.",
  whatItDoes:
    "Connects to your mailbox read-only, clusters senders, and gives you a single ranked list where one tap unsubscribes and sweeps every past message from that sender. No dashboards, no folders — one screen, one action.",
  whoPays:
    "Anyone drowning in newsletters and promo email who has tried the built-in unsubscribe and watched it fail. A one-time $4 unlock removes the 20-item cap.",
  mvp: [
    "Read-only mailbox connect",
    "Sender clustering with volume + last-seen",
    "One-tap unsubscribe + bulk archive",
    "$4 unlock via hosted USDC checkout",
  ],
  outOfScope: ["Writing or sending mail", "Multiple accounts in one view", "Mobile app (web only for v1)"],
  monetization: { model: "ONE_TIME", priceUsd: 4, priceDescription: "$4 one-time unlock, USDC checkout" },
  holderTier: { enabled: true, minHoldTokens: 250_000, perks: ["Unlock included while holding", "Vote on the roadmap queue"] },
  template: "WEB_TOOL",
  risks: ["Mailbox providers may rate-limit bulk unsubscribe", "Deliverability of unsubscribe requests varies by sender"],
};

const INBOX_DETAIL = {
  ...APPS[0],
  prompt: "A tool that unsubscribes me from email newsletters with one tap and actually removes the old messages too.",
  spec: INBOX_SPEC,
  launcher: { id: "u1", displayName: "mara", xHandle: "mara_builds", wallet: wallet("LAUNCH") },
  maintainer: { id: "u9", displayName: "kev", wallet: wallet("MAINT") },
  creatorWallet: wallet("CREATOR"),
  curveStage: "GRADUATED",
  poolAddress: wallet("POOL"),
  launchTx: sig("launch"),
  twitterUrl: "https://x.com/inbox_berth",
  websiteUrl: "https://inbox.berth.fun",
  repoUrl: "https://github.com/berth-apps/ship-inbox",
  forkOf: null,
  forksCount: 2,
  spentUsd: 138.6,
  feesSol: 41.2,
  pendingRevenueUsd: 3.0,
  uptimeBps: 9990,
  healthy: true,
  volume24hUsd: 61_200,
  liquidityUsd: 88_000,
  firstBuildAt: iso(5000),
  mvpLiveAt: iso(4980),
  firstRevenueAt: iso(4600),
  milestones: ["First deploy", "First $100 revenue", "First $1,000 revenue", "1,000 users"],
  killedReason: null,
  xAccount: "inbox_berth",
  stakeSol: 0.05,
  stakeRefundedAt: iso(4990),
};

function feedEvent(id, minAgo, type, payload, jobId = "job_inbox_v1") {
  return { id, appId: "app_inbox", jobId, type, payload: { type, ...payload }, createdAt: iso(minAgo) };
}

const INBOX_FEED = [
  feedEvent("e01", 74, "JOB_QUEUED", { stage: "SCAFFOLD", budgetUsd: 52.1 }),
  feedEvent("e02", 73, "JOB_STARTED", { stage: "SCAFFOLD", model: "claude-sonnet", sandboxId: "sbx_7f21ac" }),
  feedEvent("e03", 73, "STAGE", { stage: "SCAFFOLD", status: "START" }),
  feedEvent("e04", 72, "TOOL_CALL", { tool: "write_file", summary: "scaffolded routes, layout and theme tokens" }),
  feedEvent("e05", 71, "AGENT_NOTE", { text: "Single-column inbox with a hover unsubscribe action keeps the MVP tight and the paywall obvious." }),
  feedEvent("e06", 70, "STAGE", { stage: "SCAFFOLD", status: "DONE" }),
  feedEvent("e07", 69, "STAGE", { stage: "MVP", status: "START" }),
  feedEvent("e08", 66, "TOOL_CALL", { tool: "edit_file", summary: "one-click unsubscribe wired through @berth/app-sdk charge gate" }),
  feedEvent("e09", 64, "COMMIT", { sha: "9f2a1c7", message: "feat: one-tap unsubscribe + $4 unlock", url: "https://github.com/berth-apps/ship-inbox/commit/9f2a1c7" }),
  feedEvent("e10", 62, "TEST_RESULT", { passed: 18, failed: 0, output: "18 passing (2.3s) — playwright smoke ok" }),
  feedEvent("e11", 61, "SCREENSHOT", { url: "https://berth.fun/og.png", label: "Inbox — unsubscribe flow" }),
  feedEvent("e12", 60, "LIGHTHOUSE", { performance: 99, accessibility: 100, bestPractices: 100, seo: 100 }),
  feedEvent("e13", 59, "REVIEW", { verdict: "APPROVE", summary: "SDK-only: no auth/wallet/payment code written by the agent. CSP intact, no outbound network.", findings: [{ severity: "INFO", text: "Uses @berth/app-sdk charge() for the $4 unlock" }, { severity: "INFO", text: "No raw fetch / eval / script-src violations" }] }),
  feedEvent("e14", 58, "DEPLOY", { version: 1, url: "https://inbox.berth.fun" }),
  feedEvent("e15", 58, "JOB_FINISHED", { costUsd: 21.4, durationMs: 902_000, summary: "Shipped v1: inbox + one-tap unsubscribe + $4 unlock" }),
  feedEvent("e16", 57, "MILESTONE", { milestone: "First deploy", value: 1 }),
  feedEvent("e17", 57, "BUDGET", { budgetUsd: 30.7, delta: -21.4, reason: "build v1" }),
  feedEvent("e18", 44, "MILESTONE", { milestone: "First $100 revenue", value: 100 }, null),
  feedEvent("e19", 41, "GROWTH_POST", { url: "https://x.com/inbox_berth/status/1", text: "Shipped: one-tap unsubscribe. $4 to clean your inbox for good. Every sale burns $INBOX." }, null),
];

function buyback(o) {
  return {
    id: o.id, status: "BURNED", revenueUsd: o.revenueUsd, solSpent: o.solSpent,
    tokensBought: o.tokens, tokensBurned: o.tokens, shipUsd: o.revenueUsd * 0.1, opsUsd: o.revenueUsd * 0.05,
    attestHash: hex(64), swapTx: sig("swap" + o.id), burnTx: sig("burn" + o.id),
    error: null, createdAt: iso(o.minAgo), completedAt: iso(o.minAgo - 1),
    revenueEvents: o.events,
  };
}
const INBOX_LEDGER = {
  buybacks: [
    buyback({ id: "b3", revenueUsd: 168.0, solSpent: 1.24, tokens: 512_000, minAgo: 30, events: [
      { id: "r7", source: "CHECKOUT", usd: 4, payer: wallet("pa"), reference: "unlock", createdAt: iso(33) },
      { id: "r8", source: "SUBSCRIPTION", usd: 164, payer: wallet("pb"), reference: "team", createdAt: iso(35) },
    ] }),
    buyback({ id: "b2", revenueUsd: 96.0, solSpent: 0.71, tokens: 300_000, minAgo: 220, events: [
      { id: "r5", source: "CHECKOUT", usd: 4, payer: wallet("pc"), reference: "unlock", createdAt: iso(224) },
      { id: "r6", source: "CHECKOUT", usd: 92, payer: wallet("pd"), reference: "bulk", createdAt: iso(226) },
    ] }),
    buyback({ id: "b1", revenueUsd: 100.0, solSpent: 0.74, tokens: 331_000, minAgo: 44, events: [
      { id: "r1", source: "CHECKOUT", usd: 4, payer: wallet("pe"), reference: "unlock", createdAt: iso(60) },
    ] }),
  ],
  totals: { revenueUsd: 4213.55, buybackSol: 26.4, burnedTokens: 9_120_000, pendingRevenueUsd: 3.0 },
};

const INBOX_QUEUE = {
  items: [
    { id: "q1", text: "Add a weekly digest of what you unsubscribed from", status: "SCHEDULED", weight: 3.1, votes: 41, author: { id: "u2", displayName: "holderA", wallet: wallet("qa") }, votedByMe: false, jobId: null, createdAt: iso(120) },
    { id: "q2", text: "Support Outlook, not just Gmail", status: "OPEN", weight: 2.4, votes: 33, author: { id: "u3", displayName: "holderB", wallet: wallet("qb") }, votedByMe: false, jobId: null, createdAt: iso(200) },
    { id: "q3", text: "Undo an unsubscribe within 24h", status: "DONE", weight: 1.8, votes: 22, author: { id: "u4", displayName: "holderC", wallet: wallet("qc") }, votedByMe: false, jobId: "job_inbox_v5", createdAt: iso(1400) },
  ],
  minHoldTokens: 250_000, canSubmit: false, myWeight: 0,
};

const INBOX_BOUNTIES = {
  items: [
    { id: "bo1", title: "Dark-mode polish on the sender list", description: "Fix contrast on hover states for the recessed rows.", sol: 0.5, status: "PAID", author: { id: "u2", displayName: "holderA", wallet: wallet("ba") }, claimantWallet: wallet("cl"), prNumber: 42, escrowTx: sig("esc1"), payoutTx: sig("pay1"), createdAt: iso(900) },
    { id: "bo2", title: "Export unsubscribed list as CSV", description: "Add a download for the full sweep history.", sol: 0.8, status: "OPEN", author: { id: "u3", displayName: "holderB", wallet: wallet("bb") }, claimantWallet: null, prNumber: null, escrowTx: sig("esc2"), payoutTx: null, createdAt: iso(300) },
  ],
  nextCursor: null,
};

const INBOX_PRS = {
  items: [
    { id: "pr1", number: 44, title: "Batch unsubscribe requests to avoid provider rate limits", url: "https://github.com/berth-apps/ship-inbox/pull/44", authorLogin: "kev", authorWallet: wallet("prk"), status: "MERGED", reviewSummary: "APPROVE — SDK-only, adds backoff, tests included.", mergeSha: "a1b2c3d", createdAt: iso(500) },
    { id: "pr2", number: 47, title: "Add Outlook provider adapter", url: "https://github.com/berth-apps/ship-inbox/pull/47", authorLogin: "nadia", authorWallet: wallet("prn"), status: "REVIEWING", reviewSummary: null, mergeSha: null, createdAt: iso(120) },
  ],
  contributors: [
    { userId: "u9", displayName: "kev", wallet: wallet("MAINT"), mergedPrs: 5, earnedUsd: 210.6 },
    { userId: "u12", displayName: "nadia", wallet: wallet("prn"), mergedPrs: 2, earnedUsd: 84.2 },
  ],
  maintainer: { wallet: wallet("MAINT"), displayName: "kev" },
  maintainerVotes: [{ candidateWallet: wallet("MAINT"), weight: 5.2, voters: 61 }],
  myMaintainerVote: null,
};

const INBOX_HOLDERS = {
  items: [
    { wallet: wallet("h1"), amount: 6_100_000, pct: 6.1 },
    { wallet: wallet("h2"), amount: 4_200_000, pct: 4.2 },
    { wallet: wallet("h3"), amount: 3_050_000, pct: 3.05 },
    { wallet: wallet("h4"), amount: 2_400_000, pct: 2.4 },
    { wallet: wallet("h5"), amount: 1_900_000, pct: 1.9 },
  ],
};

function candles(res) {
  const step = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[res] ?? 900;
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  let price = 0.0011;
  for (let i = 80; i >= 0; i--) {
    const t = now - i * step;
    const o = price;
    const drift = (Math.sin(i / 6) + 0.15) * 0.00004;
    const c = Math.max(0.0002, o + drift);
    const h = Math.max(o, c) + 0.00003;
    const l = Math.min(o, c) - 0.00003;
    out.push({ t, o, h, l, c, v: 800 + Math.round(Math.abs(Math.sin(i / 3)) * 4000) });
    price = c;
  }
  return out;
}

const SHIP = {
  mint: wallet("BERTHMINT"),
  treasury: "53pWcdTUE739ApddT1DfUQ1LQG9Wd63XNW4XF7aoLmPb",
  priceUsd: 0.0142,
  marketCapUsd: 1_420_000,
  volume24hUsd: 210_000,
  holders: 1840,
  feesReceivedUsd: 6_120.0,
  revenueReceivedUsd: 611.0,
  burned: 14_300_000,
  totalStaked: 22_500_000,
  stakers: 260,
  pumpUrl: `https://pump.fun/coin/${wallet("BERTHMINT")}`,
  myStakes: [],
  topStakes: [
    { appSlug: "inbox", appName: "Inbox Zero", appTicker: "INBOX", amount: 6_200_000, stakers: 84 },
    { appSlug: "shotcaller", appName: "Shotcaller", appTicker: "SHOT", amount: 3_100_000, stakers: 41 },
    { appSlug: "tldr", appName: "QuickTLDR", appTicker: "TLDR", amount: 1_900_000, stakers: 22 },
  ],
};

export function resolve(pathname, search) {
  const p = pathname;
  if (p === "/v1/stats") return STATS;
  if (p === "/v1/ship") return SHIP;
  if (p === "/v1/apps") return { items: APPS, nextCursor: null };
  const m = p.match(/^\/v1\/apps\/([^/]+)(\/.*)?$/);
  if (m) {
    const sub = m[2] || "";
    if (sub === "" ) return INBOX_DETAIL;              // any slug -> inbox detail (we only deep-nav inbox)
    if (sub === "/feed") return { items: INBOX_FEED, nextCursor: null };
    if (sub === "/ledger") return INBOX_LEDGER;
    if (sub === "/queue") return INBOX_QUEUE;
    if (sub === "/bounties") return INBOX_BOUNTIES;
    if (sub === "/prs") return INBOX_PRS;
    if (sub === "/holders/top") return INBOX_HOLDERS;
    if (sub === "/candles") {
      const res = new URLSearchParams(search).get("res") || "15m";
      return candles(res);
    }
  }
  return null;
}

export const _debug = { APPS, STATS, SHIP };
