# Pyre

A launchpad where every coin funds and owns a real piece of software. Coins launch on **Solana** through **pump.fun**. Pyre's first 7 app coins launched on **Robinhood Chain** through PONS v2 before the move; PONS v2 launches are closed, and those 7 keep running as **legacy Robinhood Chain coins** — their fees are still swept, their apps still build, they still trade on their pages and their launchers are still paid.

You write one sentence. A coin launches on pump.fun. pump.fun's creator fee — 30 bps on the curve, a tiered share after graduation — lands in the app's wallet (on a legacy Robinhood Chain coin, 70% of PONS's 1% trade fee); every 5 minutes it is claimed and split 60/25/15 — a build budget that pays an AI agent to design, build, deploy and keep iterating on the app, a 25% share, and the launcher. On a Solana coin the 25% buys and burns the app's own coin; a Solana coin's fees never buy $PYRE. On a legacy Robinhood Chain coin the 25% funds PYRE refunds while any snapshot holder is still owed, then goes back to buying and burning Robinhood Chain $PYRE. The app is free to use; holding the coin unlocks features inside it. Holders steer the roadmap by vote. Nobody is ever paid a distribution — supply just falls, and every burn is attested on-chain.

**$PYRE is moving to Solana** through a fair launch on pump.fun with no dev buy and 100% of its creator fees going to the treasury's Solana wallet. Robinhood Chain $PYRE holders at the snapshot (block 79819827) who still hold that $PYRE are refunded the ETH they put in minus the ETH they took out, capped at what they paid for the PYRE they still held at the snapshot, at [`/refund`](https://pyre.fun/refund). The refund pool is funded by 25% of the Solana PYRE coin's creator fees and by the legacy Robinhood Chain coins' 25% share; selling or moving that $PYRE after the snapshot shrinks the refund for good — see `docs/economics.md` → *PYRE refund program*. Until the Solana coin launches, only the mint published on pyre.fun is ours.

The front page ranks coins by what is actually moving through the loop — 24 h volume, with creator fees weighted 2×, plus a heat index — not by market cap.

## How a launch actually flows

1. **Intake** — the prompt is moderated, then turned into a concrete spec (what it does, who it is for, the MVP list, an optional holder tier). The launcher approves it and it is pinned to the coin page, so buyers fund a spec rather than a vibe.
2. **Launch** — a refundable stake (`LAUNCH_STAKE_BY_CHAIN`: 1 SOL; spam control, returned at the first build) and the `launch` worker creates the coin on pump.fun through the venue adapter (`adapterFor(launchpad)` in `@pyre/chain`): `create_v2` from the app's derived Solana wallet `m/44'/501'/<1000000 + index>'/0'`, which pump.fun records as the coin's `creator`; the treasury Solana wallet pre-funds it with the predicted launch cost (≈ 0.005 SOL of rent; pump.fun charges nothing to create) plus a gas float, and the coin's metadata JSON is served by the API at `GET /v1/apps/:slug/metadata.json`. Forks launch on pump.fun too, including forks of a legacy coin. If pump.fun says no (its `createV2Enabled` switch), the app sits in `LAUNCH_GATED` and is retried every 10 minutes instead of failing. The legacy Robinhood Chain coins were launched through the PONS v2 factory from `m/44'/60'/1'/0/<index>` (PONS records that wallet as creator and `creatorFeeRecipient`, `creatorTaxBps` 0, PONS's own buyback off) against a 0.05 ETH stake; the API refuses any new `pons_v2` launch.
3. **Fees** — on Solana the 1B supply sits on the pump.fun bonding curve until it raises about 85 SOL, then graduates to a PumpSwap pool; the creator wallet earns 30 bps of every curve trade and a market-cap-tiered share (0.30%–0.95%, falling as the coin grows) of every pool trade — rates pump.fun sets and can change. On a legacy Robinhood Chain coin the 1B supply sat on a bonding curve until it raised 4.2 ETH, then graduated to a Uniswap v4 pool; in both phases 70% of the 1% trade fee goes to the app wallet. Every 5 minutes `feeSweep` claims through the adapter (pump.fun: `collect_creator_fee` / `collect_coin_creator_fee`, no sweep step; PONS: sweep into the fee escrow, then `claim`), prices the native asset in USD, and splits 60/25/15 into build budget, the 25% share (coin burn on Solana; PYRE refund pool, then $PYRE burn, on legacy coins) and the launcher. Half of the build cut is a credits slice that, once `CREDITS_FUNDING_WALLET` is set, is swapped ETH→USDC and deposited to the card that pays the model bill — so fees fund compute end to end.
4. **Build** — at $50 of accrued budget the scheduler starts the first build. An E2B microVM (`pyre-builder` template) runs the Claude Agent SDK against a fixed template, then the output must pass `npm run build`, a Playwright smoke test, screenshots, a Lighthouse audit and a reviewer model before it can deploy. Iterations cost $10–50 and consume the holder prompt queue.
5. **App** — the app goes live on its own subdomain and is free. There is no checkout, no subscription, no per-call price and no ad slot; the only thing a coin does inside its app is unlock a holder tier (`HolderGate`: hold at least N coins and a feature opens, read from `balanceOf`).
6. **Burn** — every 10 minutes the `buyback` worker runs two legs. Solana: for every coin whose `COINBURN:<appId>` ledger holds at least $5, the treasury Solana wallet buys that coin (`buy_exact_sol_in` on the curve, `buy_exact_quote_in` on PumpSwap after graduation), burns it with `burnChecked` so `getTokenSupply` falls, and sends an SPL Memo transaction reading `pyre:burn:v1:<sha256 hex>` over the fee-share entry ids it consumed. Robinhood Chain: when the `PYRE_TOKEN` ledger holds at least $5 of fee share it buys $PYRE (curve pre-graduation, Universal Router v4 after), burns it with `token.burn()`, and sends a zero-value self-transaction whose calldata is `0x5059524501 ‖ sha256(fee-share entry ids)`; the legacy coins' share lands on `PYRE_TOKEN` again only once every refund snapshot holder is settled (until then it goes to the `REFUND` pool), and what `PYRE_TOKEN` already holds keeps being burned. Either way the chain from a claimed fee to a destroyed token is checkable by anyone on Solscan or Blockscout. Legacy Robinhood coins are never bought back; Solana coins are bought back only with their own fee share, and never with anyone else's.
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

Configuration lives in `.env.example`. Nothing runs without `DATABASE_URL`, `REDIS_URL`, `GOOGLE_CLIENT_ID`, an RPC URL for chain 4663 (the legacy Robinhood Chain coins, the Robinhood treasury and the refund snapshot live there) and `PLATFORM_MASTER_SEED_HEX`; builds also need an Anthropic key and an E2B key. New coins need the Solana venue: it exists only when `SOLANA_RPC_URL` is set (`SOLANA_CLUSTER` picks `mainnet-beta` or `devnet`, `PUMP_LAUNCH_ENABLED=false` closes launches again without unsetting the RPC), and without it Pyre accepts no launches. `GET /v1/venues` lists both venues; `pons_v2` is always `enabled: false` and is listed only so legacy coin pages can describe their venue.

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

Buybacks are burns, never distributions: nothing is shared, paid or yielded to holders for holding. PYRE refunds pay back the ETH snapshot holders put in minus what they took out, capped at what they paid for the $PYRE they still held at the snapshot, and only while they keep the $PYRE they held — a refund, not a yield or a return on holding. They are paid from 25% of the Solana PYRE coin's creator fees and the legacy Robinhood Chain coins' 25% share, which goes back to burning $PYRE once every snapshot holder is settled. Apps are free; there is no in-app payment for the platform to be merchant of. All generated app code is MIT; launchers assign no IP and receive no equity and no supply allocation. pump.fun's creator fee is set by pump.fun, can change, and carries no warranty. $PYRE is moving to Solana; until that coin launches, only the mint published on pyre.fun is ours. See `docs/legal.md` — not legal advice.
