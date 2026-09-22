# Pyre

A launchpad where every coin funds and owns a real piece of software. Coins launch on **Robinhood Chain** through PONS v2 or on **Solana** through pump.fun; the loop is the same on both.

You write one sentence. A coin launches on the venue you picked. The venue's creator fee lands in the app's wallet (70% of PONS's 1% trade fee on Robinhood Chain; pump.fun's creator fee — 30 bps on the curve, a tiered share after graduation — on Solana); every 5 minutes it is claimed and split 60/25/15 — a build budget that pays an AI agent to design, build, deploy and keep iterating on the app, a buy-and-burn, and the launcher. On Robinhood Chain the 25% buys and burns $PYRE; on Solana it buys and burns the app's own coin, because $PYRE does not exist there. The app is free to use; holding the coin unlocks features inside it. Holders steer the roadmap by vote. Nobody is ever paid a distribution — supply just falls, and every burn is attested on-chain.

**$PYRE is one coin on Robinhood Chain.** It is not bridged, mirrored or launched anywhere else; any $PYRE on another chain is not us.

The front page ranks coins by what is actually moving through the loop — 24 h volume, with creator fees weighted 2×, plus a heat index — not by market cap.

## How a launch actually flows

1. **Intake** — the prompt is moderated, then turned into a concrete spec (what it does, who it is for, the MVP list, an optional holder tier). The launcher approves it and it is pinned to the coin page, so buyers fund a spec rather than a vibe.
2. **Launch** — a refundable stake (`LAUNCH_STAKE_BY_CHAIN`: 0.05 ETH on Robinhood Chain, 1 SOL on Solana; spam control, returned at the first build) and the `launch` worker creates the coin from a per-app derived wallet on the app's chain through the venue adapter (`adapterFor(launchpad)` in `@pyre/chain`). On Robinhood Chain that is the PONS v2 factory from `m/44'/60'/1'/0/<index>`, which PONS records as the creator and `creatorFeeRecipient`; the treasury pre-funds the wallet with the 0.0005 ETH launch fee plus gas, `creatorTaxBps` is 0 and PONS's own buyback is off because Pyre burns $PYRE itself. On Solana it is pump.fun's `create_v2` from `m/44'/501'/<1000000 + index>'/0'`, which pump.fun records as the coin's `creator`; the treasury Solana wallet pre-funds it with the predicted launch cost (≈ 0.005 SOL of rent; pump.fun charges nothing to create) plus a gas float, and the coin's metadata JSON is served by the API at `GET /v1/apps/:slug/metadata.json`. If the venue says no (`factory.canLaunch()` on PONS, pump.fun's `createV2Enabled` switch), the app sits in `LAUNCH_GATED` and is retried every 10 minutes instead of failing.
3. **Fees** — on Robinhood Chain the whole 1B supply sits on a bonding curve until it raises 4.2 ETH, then graduates to a Uniswap v4 pool; in both phases 70% of the 1% trade fee goes to the app wallet. On Solana the 1B supply sits on the pump.fun bonding curve until it raises about 85 SOL, then graduates to a PumpSwap pool; the creator wallet earns 30 bps of every curve trade and a market-cap-tiered share (0.30%–0.95%, falling as the coin grows) of every pool trade — rates pump.fun sets and can change. Every 5 minutes `feeSweep` claims through the adapter (PONS: sweep into the fee escrow, then `claim`; pump.fun: `collect_creator_fee` / `collect_coin_creator_fee`, no sweep step), prices the native asset in USD, and splits 60/25/15 into build budget, buy-and-burn and the launcher. Half of the build cut is a credits slice that, once `CREDITS_FUNDING_WALLET` is set, is swapped ETH→USDC and deposited to the card that pays the model bill — so fees fund compute end to end.
4. **Build** — at $50 of accrued budget the scheduler starts the first build. An E2B microVM (`pyre-builder` template) runs the Claude Agent SDK against a fixed template, then the output must pass `npm run build`, a Playwright smoke test, screenshots, a Lighthouse audit and a reviewer model before it can deploy. Iterations cost $10–50 and consume the holder prompt queue.
5. **App** — the app goes live on its own subdomain and is free. There is no checkout, no subscription, no per-call price and no ad slot; the only thing a coin does inside its app is unlock a holder tier (`HolderGate`: hold at least N coins and a feature opens, read from `balanceOf`).
6. **Burn** — every 10 minutes the `buyback` worker runs two legs. Robinhood Chain: when the `PYRE_TOKEN` ledger holds at least $5 of fee share it buys $PYRE (curve pre-graduation, Universal Router v4 after), burns it with `token.burn()`, and sends a zero-value self-transaction whose calldata is `0x5059524501 ‖ sha256(fee-share entry ids)`. Solana: for every coin whose `COINBURN:<appId>` ledger holds at least $5, the treasury Solana wallet buys that coin (`buy_exact_sol_in` on the curve, `buy_exact_quote_in` on PumpSwap after graduation), burns it with `burnChecked` so `getTokenSupply` falls, and sends an SPL Memo transaction reading `pyre:burn:v1:<sha256 hex>` over the same digest. Either way the chain from a claimed fee to a destroyed token is checkable by anyone on Blockscout or Solscan. Robinhood coins are never bought back; Solana coins are bought back only with their own fee share, and never with anyone else's.
7. **Dormancy** — budget at zero puts the app behind a "buy to relight" page. It keeps serving traffic; only the build loop stops. Any new fee, or an ETH top-up, restarts it.

## Why a prompted app can't drain a wallet

The agent never writes auth or wallet code, and there is no payment code to write. Those are platform-hosted and reached through `@pyre/app-sdk`. Generated apps run under a strict CSP with no outbound network (the template lints ban `fetch`, `XMLHttpRequest`, `WebSocket`, `eval` and script injection), server logic executes in a QuickJS sandbox with a 5 s CPU deadline and a 64 MiB cap, a reviewer model gates every deploy, and all app source is public and MIT. Keys never leave the server: browsers hold a session JWT, not a private key, and the browser's chain reads go through `POST /v1/rpc`, an allowlist of stateless read methods that cannot sign or broadcast.

## Layout

```
packages/shared     fee split, budgets, zod schemas, DTO contracts
packages/db         Prisma schema, migrations, client
packages/chain      venue adapters behind one interface (venue.ts): Robinhood Chain on viem —
                    HD wallets, PONS v2 launch/curve/fees, Uniswap v4 swaps, burn + calldata
                    attestation, holders, candles; Solana on web3.js — SLIP-0010 wallets,
                    pump.fun create_v2/curve/PumpSwap, creator-fee claims, burnChecked + memo
                    attestation, trades, holders
packages/app-sdk    browser SDK generated apps use (auth, kv, fn, llm, holder gate, track)
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

Configuration lives in `.env.example`. Nothing runs without `DATABASE_URL`, `REDIS_URL`, `GOOGLE_CLIENT_ID`, an RPC URL for chain 4663 and `PLATFORM_MASTER_SEED_HEX`; builds also need an Anthropic key and an E2B key. The Solana venue is optional: it exists only when `SOLANA_RPC_URL` is set (`SOLANA_CLUSTER` picks `mainnet-beta` or `devnet`, `PUMP_LAUNCH_ENABLED=false` hides it again without unsetting the RPC), and `GET /v1/venues` tells the web which venues are on.

## Operations

```bash
node apps/web/scripts/audit.mjs                     # perf + accessibility gate
railway ssh --service api "node apps/api/scripts/feature-audit.mjs"    # feature matrix
railway ssh --service api "node apps/api/scripts/security-check.mjs"   # perimeter
railway ssh --service api "node apps/api/scripts/probe-intake.mjs"     # push one app through intake
railway ssh --service api "node apps/api/scripts/seed-demo-data.mjs --remove"   # purge seeded fixtures (production is already clean)
```

`PlatformSetting.pause_builds = true` is the global kill switch for building; `pauseFeeSweep` and `pauseBuyback` stop money movement on both chains. The reconcile worker runs every 5 minutes and reports drift across jobs, sandboxes, job tokens, the ledger, unrecorded escrow claims, burned $PYRE supply and burned Solana coin supply.

See [`docs/go-live.md`](docs/go-live.md) for the deployed state, the verification results, and what is still blocked on funding.

## Design

Heat, not flame. An obsidian canvas with a tempered-violet accent ("Obsidian Temper"); Instrument Serif for headlines, Geist for UI and prose, Geist Mono for every number, address and hash. Fire is shown through consequence — supply shrinking in the Supply Kiln, ledger rows cooling from white-hot to violet — never as a flame glyph.

## Legal posture

Buybacks are burns, never distributions. Nothing is shared, paid or yielded to holders. Apps are free; there is no in-app payment for the platform to be merchant of. All generated app code is MIT; launchers assign no IP and receive no equity and no supply allocation. pump.fun's creator fee is set by pump.fun, can change, and carries no warranty. $PYRE is one coin on Robinhood Chain; any $PYRE on another chain is not us. See `docs/legal.md` — not legal advice.
