# Pyre

A launchpad where every coin funds and owns a real piece of software.

You write one sentence. A coin launches on pump.fun. 60% of its trading fees become a build budget that pays an AI agent to design, build, deploy and keep iterating on the app. The app charges its own users, and 85% of that revenue buys the coin back on the open market and burns it. Holders steer the roadmap by vote. Nobody is ever paid a distribution — supply just falls.

The front page ranks coins by the dollars their product earned, not by volume.

## How a launch actually flows

1. **Intake** — the prompt is moderated, then turned into a concrete spec (what it does, who pays, the MVP list, the price). The launcher approves it and it is pinned to the coin page, so buyers fund a spec rather than a vibe.
2. **Launch** — a refundable 0.05 SOL stake (spam control, returned at the first build) and the coin is created on pump.fun by a per-app derived keypair, which is also the coin's fee creator.
3. **Fees** — `feeSweep` collects creator fees every 5 minutes and splits them 60/25/15 into build budget, $PYRE and the launcher. Half of the build-budget cut is a credits slice, swept SOL→USDC→a card wallet whose auto-reload keeps the model bill paid, so fees fund compute end to end (`CREDITS_FUNDING_WALLET`, off until set).
4. **Build** — at $50 of accrued budget the scheduler starts the first build. An E2B microVM runs the Claude Agent SDK against a fixed template, then the output must pass `npm run build`, a Playwright smoke test, screenshots, a Lighthouse audit and a reviewer agent before it can deploy. Iterations cost $10–50 and consume the holder prompt queue.
5. **Revenue** — the app takes USDC through hosted checkout, x402 per-call payments, an ad slot, or a holder tier. Revenue splits 85/10/5 into buyback-and-burn, $PYRE and ops. Each burn's memo carries a sha256 of the exact revenue event ids it settles, so the chain from a payment to a destroyed token is reproducible by anyone.
6. **Dormancy** — budget at zero puts the app behind a "buy to revive" page. It keeps serving traffic and earning; only the build loop stops. Any new fee restarts it.

## Why a prompted app can't drain a wallet

The agent never writes auth, wallet or payment code. Those are platform-hosted and reached through `@pyre/app-sdk`. Generated apps run under a strict CSP with no outbound network, server logic executes in a QuickJS sandbox with a 5s deadline and a 64MB cap, a reviewer agent gates every deploy, and all app source is public and MIT.

## Layout

```
packages/shared     fee/revenue splits, budgets, zod schemas, DTO contracts
packages/db         Prisma schema, migrations, client
packages/chain      Solana: derived keypairs, pump.fun launch, creator-fee sweep,
                    Jupiter buyback + burn with memo attestation, holders, candles
packages/app-sdk    browser SDK generated apps use (auth, charge, kv, fn, holder gate, ads)
apps/api            Express: platform API, SSE build feed, Anthropic proxy with
                    per-job budget tokens, app hosting + QuickJS function runtime
apps/runner         BullMQ workers: intake, launch, build, reviewer, fee sweep,
                    buyback, monitor, growth, reconcile
apps/web            React 19 + Vite front end
template/           the app template the agent builds inside
docs/               architecture, economics, legal posture, runbook, go-live
```

## Running it

```bash
npm ci
npm run db:generate
npm run build            # shared → db → chain → app-sdk → api → runner → web
npm test                 # 211 tests, no network
npm run dev:api          # also: dev:runner, dev:web
```

Configuration lives in `.env.example`. Nothing runs without `DATABASE_URL`, `REDIS_URL`, a Privy app, a Solana RPC, and — for builds — an Anthropic key and an E2B key.

## Operations

```bash
node apps/web/scripts/audit.mjs                     # perf + accessibility gate
railway ssh --service api "node apps/api/scripts/feature-audit.mjs"    # 53-feature matrix
railway ssh --service api "node apps/api/scripts/security-check.mjs"   # perimeter
railway ssh --service api "node apps/api/scripts/probe-intake.mjs"     # push one app through intake
railway ssh --service api "node apps/api/scripts/seed-demo-data.mjs --remove"   # purge demo content
```

`PlatformSetting.pause_builds = true` is the global kill switch for building. The reconcile worker runs every 5 minutes and reports drift across jobs, sandboxes, job tokens, the ledger and uncollected fees.

See [`docs/go-live.md`](docs/go-live.md) for the deployed state, the verification results, and what is still blocked on funding.

## Design

A 1-bit pixel terminal. Silkscreen for the machine voice (wordmark, headings, labels), Inter for prose, JetBrains Mono for every number and hash. Nothing is rounded, depth is a hard offset shadow, loading is a dithered block, and the single green accent is spent almost entirely on money.

## Legal posture

Buybacks are burns, never distributions. No revenue share, no dividend, no yield. The platform is merchant of record for app payments. All generated app code is MIT; launchers assign no IP and receive no equity and no supply allocation. See `docs/legal.md` — not legal advice.
