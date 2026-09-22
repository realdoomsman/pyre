# Pyre

A launchpad on Robinhood Chain where every coin funds and owns a real piece of software.

You write one sentence. A coin launches on PONS v2. 60% of its creator fees become a build budget that pays an AI agent to design, build, deploy and keep iterating on the app. The app charges its own users in USDG, and 85% of that revenue buys the coin back on the curve or in its pool and burns it. Holders steer the roadmap by vote. Nobody is ever paid a distribution — supply just falls, and every burn is attested on-chain.

The front page ranks coins by what is actually moving through the loop — 24 h volume, with revenue weighted 3× and creator fees 2× — and by supply burned, not by volume alone.

## How a launch actually flows

1. **Intake** — the prompt is moderated, then turned into a concrete spec (what it does, who pays, the MVP list, the price). The launcher approves it and it is pinned to the coin page, so buyers fund a spec rather than a vibe.
2. **Launch** — a refundable 0.05 ETH stake (`LAUNCH_STAKE_WEI`; spam control, returned at the first build) and the `launch` worker creates the coin through the PONS v2 factory from a per-app derived wallet (`m/44'/60'/1'/0/<index>`), which PONS records as the creator and `creatorFeeRecipient`. The treasury pre-funds that wallet with the 0.0005 ETH launch fee plus gas; `creatorTaxBps` is 0 and PONS's own buyback is off because Pyre does its own. If `factory.canLaunch()` says no, the app sits in `LAUNCH_GATED` and is retried every 10 minutes instead of failing.
3. **Fees** — the whole 1B supply sits on a bonding curve until it raises 4.2 ETH, then graduates to a Uniswap v4 pool; in both phases 70% of the 1% trade fee goes to the app wallet. Every 5 minutes `feeSweep` sweeps accrued fees into the PONS fee escrow, claims them, prices the ETH in USD, and splits 60/25/15 into build budget, $PYRE buyback and the launcher. Half of the build cut is a credits slice that, once `CREDITS_FUNDING_WALLET` is set, is swapped ETH→USDG and deposited to the card that pays the model bill — so fees fund compute end to end.
4. **Build** — at $50 of accrued budget the scheduler starts the first build. An E2B microVM (`pyre-builder` template) runs the Claude Agent SDK against a fixed template, then the output must pass `npm run build`, a Playwright smoke test, screenshots, a Lighthouse audit and a reviewer model before it can deploy. Iterations cost $10–50 and consume the holder prompt queue.
5. **Revenue** — the app takes USDG through hosted checkout, per-call function payments, an ad slot, or a holder tier. Custodial users never need gas: their wallet signs an EIP-3009 `transferWithAuthorization` and the treasury relays it. Revenue splits 85/10/5 into buyback-and-burn, $PYRE and ops. Every 10 minutes the `buyback` worker buys the coin with the pending 85% (curve pre-graduation, Universal Router v4 after), burns it with `token.burn()`, and sends a zero-value self-transaction whose calldata is `0x5059524501 ‖ sha256(revenue event ids)` — so the chain from a payment to a destroyed token is reproducible by anyone on Blockscout.
6. **Dormancy** — budget at zero puts the app behind a "buy to relight" page. It keeps serving traffic and earning; only the build loop stops. Any new fee, or an ETH top-up, restarts it.

## Why a prompted app can't drain a wallet

The agent never writes auth, wallet or payment code. Those are platform-hosted and reached through `@pyre/app-sdk`. Generated apps run under a strict CSP with no outbound network (the template lints ban `fetch`, `XMLHttpRequest`, `WebSocket`, `eval` and script injection), server logic executes in a QuickJS sandbox with a 5 s CPU deadline and a 64 MiB cap, a reviewer model gates every deploy, and all app source is public and MIT. Keys never leave the server: browsers hold a session JWT, not a private key, and the browser's chain reads go through `POST /v1/rpc`, an allowlist of stateless read methods that cannot sign or broadcast.

## Layout

```
packages/shared     fee/revenue splits, budgets, zod schemas, DTO contracts
packages/db         Prisma schema, migrations, client
packages/chain      Robinhood Chain on viem: HD wallets, PONS v2 launch/curve/fees,
                    Uniswap v4 swaps, USDG EIP-3009, burn + attestation, holders, candles
packages/app-sdk    browser SDK generated apps use (auth, charge, kv, fn, holder gate, ads)
apps/api            Express: platform API, SSE feeds, read-only RPC proxy, Anthropic proxy
                    with per-job budget tokens, app hosting + QuickJS function runtime
apps/runner         BullMQ workers: intake, launch, build, PR review, fee sweep, buyback,
                    price, holders, market, monitor, growth, reconcile
apps/web            React 19 + Vite front end
template/           the app template the agent builds inside
docs/               architecture, economics, legal posture, runbook, go-live
```

## Running it

```bash
npm ci
npm run db:generate
npm run build            # shared → db → chain → app-sdk → api → runner → web
npm test                 # 408 tests, no network
npm run dev:api          # also: dev:runner, dev:web
```

Configuration lives in `.env.example`. Nothing runs without `DATABASE_URL`, `REDIS_URL`, `GOOGLE_CLIENT_ID`, an RPC URL for chain 4663 and `PLATFORM_MASTER_SEED_HEX`; builds also need an Anthropic key and an E2B key.

## Operations

```bash
node apps/web/scripts/audit.mjs                     # perf + accessibility gate
railway ssh --service api "node apps/api/scripts/feature-audit.mjs"    # feature matrix
railway ssh --service api "node apps/api/scripts/security-check.mjs"   # perimeter
railway ssh --service api "node apps/api/scripts/probe-intake.mjs"     # push one app through intake
railway ssh --service api "node apps/api/scripts/seed-demo-data.mjs --remove"   # purge seeded fixtures (production is already clean)
```

`PlatformSetting.pause_builds = true` is the global kill switch for building; `pauseFeeSweep` and `pauseBuyback` stop money movement. The reconcile worker runs every 5 minutes and reports drift across jobs, sandboxes, job tokens, the ledger, unrecorded escrow claims and burned supply.

See [`docs/go-live.md`](docs/go-live.md) for the deployed state, the verification results, and what is still blocked on funding.

## Design

Heat, not flame. An obsidian canvas with a tempered-violet accent ("Obsidian Temper"); Instrument Serif for headlines, Geist for UI and prose, Geist Mono for every number, address and hash. Fire is shown through consequence — supply shrinking in the Supply Kiln, ledger rows cooling from white-hot to violet — never as a flame glyph.

## Legal posture

Buybacks are burns, never distributions. No revenue share, no dividend, no yield. The platform is merchant of record for app payments. All generated app code is MIT; launchers assign no IP and receive no equity and no supply allocation. See `docs/legal.md` — not legal advice.
