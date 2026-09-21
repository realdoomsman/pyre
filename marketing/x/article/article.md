# Berth: coins that build apps

*A launchpad where every coin funds and owns a real piece of software. Fees pay an AI agent to build the app. The app charges its own users, and its revenue buys the coin back and burns it. The front page ranks coins by the dollars their product earned — not by volume.*

> **Figure — hero:** `brand/banner.png`

Most token launches sell a promise and a chart. Berth sells a product. You write one sentence describing an app. A coin launches on pump.fun. Its trading fees become a build budget that pays an AI agent to design, build, deploy and keep iterating on that app. The app then charges real users, and **85% of everything it earns buys the coin back on the open market and burns it.** Nobody is ever paid a distribution. Supply just falls.

This article walks through exactly how that works, why a prompted app can't drain your wallet, and what has already been verified running in production. Every claim here maps to public code — every generated app is MIT-licensed and open.

---

## The one-sentence launch

You don't write code. You write the idea. From there the machine takes over, but you stay in control at the two moments that matter: approving the spec, and signing the stake.

1. **Intake.** Your prompt is moderated, then turned into a concrete spec — what the app does, who pays for it, the MVP list, and the price. You approve it, and the spec is pinned to the coin page. Buyers fund a spec, not a vibe.
2. **Launch.** A refundable **0.05 SOL** stake (spam control, returned at the first build) and the coin is created on pump.fun by a per-app derived keypair, which is also the coin's fee creator.
3. **It builds itself from here.**

> **Figure — the launch value prop:** `cap/launch.png`
> *Berth's launch page: you write one sentence; an agent writes the spec, builds the app, deploys it, and keeps shipping. 60% of creator fees fund the build, 15% go to you, 85% of revenue burns the coin.*

---

## The money: two streams, one direction

Two independent streams of money flow through every coin, and both are pointed at the product.

**Creator fees** (pump.fun pays the coin creator a share of trading volume) split:

- **60% → the app's build budget** (half of this is a per-coin credits slice that pays the model bill)
- **25% → $BERTH buyback** (the platform coin)
- **15% → the launcher** (you)

**App revenue** (what the app charges its own users) splits:

- **85% → buyback-and-burn of the app's own coin**
- **10% → $BERTH**
- **5% → platform ops**

> **Figure — money flow:** `posts/loop.png`

The consequence is simple: **fees fund the build, revenue funds the burn.** Trading pays to make the product better; the product's income permanently removes supply. There is no revenue share, no dividend, no yield — buybacks are burns, executed on-chain by the platform.

---

## The build loop: an agent that ships behind a gate

At **$50** of accrued build budget, the scheduler starts the first build. Here's what actually happens inside:

- The runner spins up an **E2B microVM** and drives the **Claude Agent SDK** against a fixed app template.
- The agent works, and every step — notes, stages, tool calls, commits — streams live to the coin page as a public build log.
- Before anything deploys, the output **must pass**: `npm run build`, a **Playwright** smoke test, screenshots, a **Lighthouse** audit, and a **reviewer agent** that reads the diff and blocks unsafe code or spec drift.
- On approve: commit, push, deploy, version bump. The budget is debited by the **actual metered cost** of the job, not a flat fee.

Iterations run whenever budget allows ($10–50 per job) and consume the holder prompt queue — so the roadmap is literally what holders voted for.

> **Figure — the build log is public:** `cap/el/buildlog.png`
> *A real build streaming: scaffold → MVP → commit → 18 tests passing → Lighthouse 99/100 → reviewer APPROVE ("SDK-only: no auth/wallet/payment code written by the agent") → deploy v1. (Representative data shown.)*

---

## Why a prompted app can't drain a wallet

This is the question that matters, so here is the honest, specific answer. The safety isn't a promise — it's the architecture.

- **The agent never writes auth, wallet, or payment code.** Those are platform-hosted and reached only through `@berth/app-sdk`. The agent literally cannot hand-roll a transfer.
- **Strict CSP, no outbound network.** Generated apps run under a content-security policy that bans raw `fetch`, `XMLHttpRequest`, `WebSocket`, external scripts and `eval`. Lint rules enforce it before code ever ships.
- **Server logic runs in a QuickJS sandbox** — 64 MB memory, a 5-second deadline, no arbitrary network.
- **A reviewer agent gates every deploy**, and its hard blocks are scoped to files that actually ship. A false positive there would block every deploy forever, so it's pinned by regression tests.
- **All app source is public and MIT.** You can read exactly what runs.

> **Figure — the perimeter:** `posts/safety.png`

---

## The part that makes it real: on-chain attestation

Anyone can claim revenue. Berth makes it checkable. Berth is the merchant of record, so every USDC checkout, subscription and per-request (x402) call is verified on-chain by signature and memo before a revenue event exists. When enough revenue accumulates, the executor buys the coin back and burns it — and **each burn's memo carries a sha256 of the exact revenue-event ids it settles.**

That means the chain from *a payment* to *a destroyed token* is reproducible by anyone. Pull the swap and the burn, hash the ids, and you get the same string. No trust in the dashboard required.

> **Figure — buyback + burn, end to end:** `cap/el/attest.png`
> *One burn batch: revenue attested → SOL spent buying the coin → tokens burned → the sha256 attestation written into both transaction memos. (Representative data shown.)*

---

## The leaderboard: ranked by what the product earned

The front page does not rank by volume, market cap, or how loud the launch was. It ranks coins by **the dollars their app collected from real users.** A coin whose product earned money sits at the top; a coin with a chart and no product does not.

> **Figure — the leaderboard:** `cap/el/board.png`
> *Coins ranked by revenue earned, with build status live per row. (Representative data shown.)*

Every coin page shows the same thing at three depths: is it making money, is it being built, and can I verify it — the money block, the live build log, and the full burn ledger with its attestation.

> **Figure — a coin page money block:** `cap/el/money.png`

---

## $BERTH: the platform coin

$BERTH is the coin the platform itself runs on. It has exactly two inflows — **25% of every app's creator fees and 10% of every app's revenue** — and two one-way sinks:

- **Buyback and burn.** The treasury balance is swapped for $BERTH and the tokens are destroyed.
- **Stake to boost.** Holders can stake $BERTH against a specific app to move it to the front of the build queue and earn that app's staker fee share while staked. Unstake any time; the same amount comes back.

Neither sink pays, distributes, or promises anything to holders. It's build priority and supply reduction — not a yield product.

> **Figure — $BERTH sinks:** `cap/el/burned.png`

---

## When a coin runs out of budget

Budget at zero doesn't kill an app. It goes **dormant**: the live app keeps serving traffic and keeps earning revenue — only the build loop stops. It sits behind a "buy to revive" page, and any new trading fee or a direct top-up restarts it. Nothing is abandoned; it just waits for fuel.

> **Figure — dormancy:** `posts/dormant.png`

---

## What's already verified in production

Berth is engineered like infrastructure, not a weekend launch. As of go-live, verified against the live stack:

- **211 tests pass** with no network, DB, Redis, RPC or model access.
- **50 / 53 feature matrix** — the only three not passing are blocked purely on funding (credits and treasury SOL), and are labelled as such.
- **Security perimeter: 31 PASS / 0 FAIL** against the live API — unauth access blocked on every authed route, cross-origin mutations rejected, rate limits, webhook replay protection, CSP and cookie flags present.
- **Reconcile: 0 drift** across jobs, sandboxes, tokens, the ledger and uncollected fees.
- **A real build pipeline runs end to end in production** — sandbox boots, template lands, `npm ci` + build + Playwright + screenshots + Lighthouse + the reviewer's policy gate all execute. It stops at exactly one place: the model credit balance.

> **Figure — receipts:** `posts/receipts.png`

In the interest of honesty: Berth is at its **starting line**. The engine is built, deployed and verified; what's ahead is the first real launches funding the first real builds. The screenshots in this article use representative data to show the interface — they are not claims of revenue already earned.

---

## How to launch (when you're ready)

1. Sign in (X, email, or a Solana wallet — you get an embedded wallet).
2. Go to **Launch**, write your one sentence, and let the intake agent turn it into a spec.
3. Approve the spec and sign the refundable 0.05 SOL stake.
4. The coin goes live on pump.fun; fees start accruing to the build budget.
5. At $50 of budget, the first build starts — watch it stream on the coin page.
6. As the app earns, revenue buys the coin back and burns it, with the attestation hash written into every memo.

---

## Legal posture

Buybacks are burns, never distributions. No revenue share, no dividend, no yield. The platform is the merchant of record for app payments. All generated app code is MIT; launchers assign no IP and receive no equity and no supply allocation. Coins are not investments, apps can fail, and nothing here is financial advice.

---

**berth.fun** — fees fund the build. revenue funds the burn.

> **Figure — close:** `cap/el/card-coin.png`
