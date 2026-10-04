# Go-live checklist

Live state of Pyre on Robinhood Chain as of 2026-09-21, annotated on 2026-09-22 where the removal of in-app payments changed it and on 2026-10-04 for the move to Solana: new coins launch on pump.fun only, PONS v2 launches are closed in code, and the 7 Robinhood Chain coins launched since the 2026-09-21 record (deadline-radar-2, basket, pyrecat, jackpot-2, paperhood-4, pyredog-3, business-builder) keep running as legacy coins. *Deployed*, *Verified against production* and *Blocked on you* are the 2026-09-21 record. Lines marked **pending** have not been run against production yet; nothing below is inferred. Secrets live in `.secrets/pyre-keys.env` (git-ignored) and are set on the Railway services.

## PYRE → Solana

PYRE relaunches on Solana as a fair launch on pump.fun — the founder's 2 SOL dev buy at creation is locked for 12 months on Streamflow — with 100% of its creator fees going to the treasury Solana wallet; Robinhood Chain holders at the snapshot who still hold that PYRE are refunded at `/refund` (`docs/economics.md` → *PYRE refund program*). The refund pool is funded by 25% of the Solana PYRE coin's creator fees and by the legacy Robinhood Chain coins' 25% share while any snapshot holder is still owed.

- **Snapshot recorded:** Robinhood Chain block `79819827`, hash `0x141e47824b2a808e47e0e4d5262f7c7b3eb0b4f77c6d0b1113b7aa11874df0d8`, 2026-10-04T09:12:28Z (`docs/sol-migration-snapshot.md`).
- **Announced:** pinned post https://x.com/PyreFun/status/2106687742541287487 (2026-10-04, 10:07:52Z, after the snapshot). The first announcement (09:18:42Z) was deleted.
- **Snapshot loaded (2026-10-04):** migration `20261004000000_pyre_refund` applied on api start; `load-refund-snapshot.mjs` created 785 `RefundHolder` rows on the production runner. `GET /v1/refund` reports 785 holders, 229 owed, 11.846939549841023398 ETH owed, pool 0.
- **Solana coin launched (2026-10-04):** mint `5H3MALVQ1swoJcyMyADfc7esbJomRLsKRyG8WjbG6fg5` (`Pyre` / `PYRE`, Token-2022, 1B supply, no mint or freeze authority), created by the founder on pump.fun with a 2 SOL dev buy. Dev buy locked on Streamflow (`2iQK2icSJgpY8PQMqrDniRAZsS1M5NFgeFe7tnQkVpm8`, decoded on-chain): 66,728,855.72 PYRE, single unlock 2027-10-04 04:00 UTC, not cancelable or transferable by either side, no top-up; the founder wallet `DTmqhjg2qJuzQY9ergHVC1KfAFBnc3GgGAG2pVm6aWzv` holds 0.000001 PYRE outside it. Fee route read with `pumpCreatorFeeRoute`: `shared`, sharing config `C8PYLZnLai67nCcgom15DSxGwSJUWoW9PBsPazJPSh5M`, sole shareholder the treasury Solana wallet `CZeNrWsfVqBciYLWYoLGc2wcMqozsAeVB14HVMwWqjah` at 10 000 bps.
- **`PYRE_SOL_MINT`:** set on `api` and `runner` (2026-10-04). From the next `feeSweep` pass the treasury distributes and collects the coin's creator fees and 25% of each distribution is credited to `REFUND`.
- **Pending — treasury Solana wallet funding for refunds:** payouts are SOL from the treasury Solana wallet; the legacy coins' share arrives as ETH in the Robinhood treasury and nothing bridges automatically, so the wallet must be funded by hand to cover outstanding credit.

## Deployed

Railway project **`pyre`** (`33701d8a-7fa9-4255-8640-d508c174af14`), environment `production`. Deploy with `railway up --service <api|runner|web> --ci`.

| Service | URL | State |
| --- | --- | --- |
| web | https://pyre.fun | Online; custom domain verified, certificate valid; `GET /` → 200 |
| api | https://api.pyre.fun | Online; `GET /health` → `{"ok":true}`; `GET /v1/status` reports db 14 ms, redis 14 ms, rpc 114 ms at block 68 778 787, chain id 4663 |
| apps | `*.pyre.fun` → api | Custom domain `ACTIVE`; `https://<unknown>.pyre.fun` serves the API's 404 over a valid wildcard certificate |
| runner | internal worker | Online; boot log lists all 13 queues (`intake build scheduler monitor prReview launch feeSweep buyback price holders market growth reconcile`), template `pyre-builder` |
| Postgres | `postgres.railway.internal` | Online; migrations applied by `prisma migrate deploy` on api start |
| Redis | `redis.railway.internal` | Online; queues + feed pub/sub |

DNS at Porkbun: `ALIAS @ → qok06i6z.up.railway.app`, `CNAME api → ee3pjfqz.up.railway.app`, `CNAME * → pyagq8qz.up.railway.app`, plus the `_railway-verify` and `_acme-challenge` TXT records. All three Railway domains show `Sync: ACTIVE`.

Production configuration:

| Variable | Value | Note |
| --- | --- | --- |
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` (since 2026-10-04) | the Alchemy key was over its monthly capacity and `/v1/status` reported `rpc ok:false`; switched to the public endpoint on `api` + `runner`, now `rpc ok:true`. Upgrade Alchemy and switch back for capacity (blocked item 4) |
| `CHAIN_ID` | `4663` | |
| `PLATFORM_MASTER_SEED_HEX` | set (new seed) | backed up in `.secrets/pyre-keys.env` |
| treasury (`m/44'/60'/0'/0/0`) | `0xdd9F2043c2df2Cd675ff4eF75373E82bB68389b6` | ≈0 ETH on 2026-10-04 (8.2e-7 ETH): legacy sweeps and launcher claims stall until funded (blocked item 1); Zentro top-ups no longer draw on it |
| `USDG_ADDRESS` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | account balances and deposits only; apps take no payments |
| `PYRE_TOKEN` | `0xc8488bE2e4f430420A364E64f4D8af428b74D903` on `api` + `runner` | Robinhood Chain PYRE (legacy); the Solana coin is `PYRE_SOL_MINT`, unset until the founder's launch |
| `E2B_TEMPLATE` | `pyre-builder` | template built and published |
| `GOOGLE_CLIENT_ID` / `VITE_GOOGLE_CLIENT_ID` | set | |
| `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_WEBHOOK_SECRET` | set | |
| `BLOCKSCOUT_API_KEY` | unset | holders self-index from `Transfer` logs (blocked item 4) |
| `ZENTRO_STATE` | set on `runner` (re-captured 2026-10-04) | the previous session had expired (`zentro_session_expired`); `probe-zentro.mjs 15 --quote` on the production runner minted a deposit address, nothing sent. Top-ups pay in SOL from the treasury Solana wallet `CZeNrWsfVqBciYLWYoLGc2wcMqozsAeVB14HVMwWqjah` (ETH before the 2026-10-04 cutover; live Relay quote for this wallet: 0.1245 SOL ≈ $15.15 for $15 USDC, one deposit instruction + one lookup table) and wait while it holds less than the top-up plus the 0.1 SOL floor. Card balance C$3.10 on 2026-10-04 |
| `PAYOUTS_FROZEN` | `0` on `api` (since 2026-10-04) | was `1` since the 2026-09-23 staker-claim drain (parallel `POST /v1/pyre/claim` each paid the same `earnedMicros`: $4,717.65 paid against $5.25 accrued). Fixed with a guarded decrement in `claimStakerRewardsHandler` + `apps/api/test/pyre-claim.test.ts`, then unfrozen |
| `X_API_*` | unset | growth posts are recorded as `[X not connected]` |
| `APP_DOMAIN` / `VITE_APP_DOMAIN` | `pyre.fun` | apps serve at `<slug>.pyre.fun` |
| `SOLANA_RPC_URL` / `SOLANA_CLUSTER` / `PUMP_LAUNCH_ENABLED` | Helius mainnet URL / `mainnet-beta` / `true` on `api` + `runner` (2026-10-04) | `GET /v1/venues` → `pons_v2:false pump_fun:true`; `/v1/status` `solana ok:true`. `SOLANA_WSS_URL` unset: web3.js derives the websocket from the Helius URL |

## Verified against production

- **Perimeter smoke** (observed): `GET /v1/me` without a token → 401; `POST /v1/rpc` with `eth_sendRawTransaction` → 403 `rpc_method_not_allowed`; `GET /metrics` without the internal secret → 401; `GET /v1/apps` lists and paginates.
- **Runner** (observed in logs): fee sweep, buyback scan, price refresh, holders, growth daily and reconcile passes all tick; reconcile `JOBS`, `SANDBOXES`, `JOBTOKENS`, `LEDGER` (6 checked), `FEES` (3 checked) report clean; an ITERATE build on a demo app ran through sandbox bootstrap on the prebuilt 4 GB `pyre-builder` VM, the agent stage and the reviewer model, which rejected it for spec drift — the pipeline reaches the model and back.
- **Feature matrix** — `railway ssh --service api "node apps/api/scripts/feature-audit.mjs"` (run 2026-09-21 in the api container): **62 passed · 0 failed · 6 blocked on funding · 0 skipped** of 68 features. That run predates the 2026-09-22 cutover that made apps free: the two blocked rows for in-app payments no longer exist, so the counts are stale and the matrix is **pending** a re-run after the cutover deploys. The remaining blocked rows — custodial stake, bounty escrow/payout, top-up — each reach their funding gate and refuse cleanly (400/402/502) because the treasury and fixture wallets hold nothing.
- **Perimeter** — `node apps/api/scripts/security-check.mjs https://api.pyre.fun`: **28 passed · 0 failed · 2 skipped** while the `demo` app was hosted (the two skips need `PYRE_GITHUB_SECRET` / `PYRE_PROXY_TOKEN` in the caller's env; both paths are covered by the feature matrix). Since the purge the script's app-origin rows (CSRF on `/_pyre/*`, app cookie flags, app-function rate class) report `404 unknown app` because it targets `/a/demo`; they pass again once any app is hosted. Do not quote a perimeter pass count publicly until then.
- **Web audit** — `node apps/web/scripts/audit.mjs --seed-slug=inboxzero` against `https://api.pyre.fun` (run before the purge; the seed slug no longer exists, so run without `--seed-slug` or point the coin route at `.tmp/mock-api.mjs` on :8787): **all budgets met** — perf 93–100, a11y 100 and 0 console errors on `/`, `/launch`, `/apps`, `/burns`, `/pyre`, `/c/:slug`, `/me`, `/legal/terms`, `/card`; initial JS 160–326 kB; no wallet chunk in any initial graph.
- **Route smoke** — every route on `https://pyre.fun` and the dev build at 1440 and 390 with live data, `scrollWidth === 390` on mobile everywhere, keyboard order and reduced-motion checked (screenshots in `.tmp/real/`, `.tmp/polish/`).
- **Independent reviews** — security review: 1 High (treasury drain via arbitrary stake tx), 5 Medium, 5 Low — all fixed with regression tests; code review: 13 findings (nonce serialisation, $PYRE buyback state machine, market cursor, holders batching, payout confirmation, …) — all fixed.
- **Reconcile in prod** — `JOBS`, `SANDBOXES`, `JOBTOKENS`, `LEDGER`, `FEES`, `PAYOUTS`, `BURNS` clean (the `BURN_TOKEN_NOT_A_CONTRACT` notes went away with the seeded demo tokens). Since the cutover `BURNS` covers `PyreBurn` rows only.
- **On-chain dry run** (real PONS v2 launch → sweep → buy → burn → attest, hashes recorded here): **pending**, blocked on treasury ETH. Every write path is unit-tested and simulated (`eth_estimateGas` / `simulateContract`) against the live factory; `apps/runner/scripts/launch-pyre.mjs` refuses to run until the treasury is funded.
- **Tests** — `npm test`: 408 passed, 5 skipped (live-chain tests, opt-in with `CHAIN_LIVE_TESTS=1`), ~6 s, no network/DB/Redis/RPC/model access.
- **Build** — `npm run build` green for every package; CI (`.github/workflows/ci.yml`) runs the same sequence on Node 24 plus a migration-drift check.
- **X** — article, pinned post with the launch video, day-1 post and 20 scheduled posts (Sep 22 → Oct 11, 15:00 daily), profile assets and five replies are live under `@PyreFun`; the log is in `marketing/x/pyre/posts/posts.md`.

## Demo content — purged

Production was purged on 2026-09-21: `seed-demo-data.mjs --remove` and `seed-demo-app.mjs demo --remove` were run against the api service, so the public feed, app store, burn ledger and `/v1/stats` show zeros. Nothing on the site is seeded, sampled or projected; the first number to appear will be a real one. The seeding scripts still exist for local and staging work — never run them without `--remove` against production again. `apps/api/scripts/probe-intake.mjs` pushes one real app through the intake queue and reports what the runner did with it.

## Blocked on you

1. **Treasury ETH.** `0xdd9F2043c2df2Cd675ff4eF75373E82bB68389b6` holds 0 ETH. It pre-funds every launch (0.0005 ETH fee + gas), pays gas for sweeps, the $PYRE buyback, burns, attestations and stake refunds, and refuses to act below a 0.01 ETH floor — so nothing on-chain moves until it is funded. Send **~0.05 ETH on Robinhood Chain** (bridge from Arbitrum One or Ethereum, or withdraw directly from an exchange that supports chain 4663). Confirm at `https://robinhoodchain.blockscout.com/address/0xdd9F2043c2df2Cd675ff4eF75373E82bB68389b6`. The ops page raises `treasury_low` under 0.02 ETH.
2. **Anthropic credit balance.** The key is set and the reviewer model answered during a production build, but the balance has not been checked. Confirm it in the Anthropic Console and set auto-reload; an empty balance fails every agent call with `credit balance is too low` while E2B sandboxes still bill. If you want builds held until then: `POST /v1/admin/settings { "key": "pause_builds", "value": true }`. To make fees pay for compute afterwards, set the Zentro card as the billing method with auto-reload and set `ZENTRO_STATE` on `runner` (see `docs/runbook.md` → Model-credit funding).
3. **$PYRE launch.** `PYRE_TOKEN` is empty, so the $PYRE share (25% of every Robinhood coin's creator fees) accrues on the `PYRE_TOKEN` ledger without being swapped or burned, staking and platform governance are closed, and `/pyre` shows the pre-launch state. Launch from the treasury after step 1 (procedure in `docs/runbook.md` → Launching $PYRE), then set `PYRE_TOKEN` on `api` and `runner` and `VITE_PYRE_TOKEN` on `web` and redeploy.
4. **Optional keys.** (a) **Alchemy** — create a Robinhood Chain app, set `RPC_URL` on `api` and `runner`; the public RPC is rate-limited per origin and shared by the indexer, price, holders, reconcile and every browser read. (b) **Blockscout API key** — set `BLOCKSCOUT_API_KEY` on `runner` so holder lists come from the explorer instead of self-indexed logs. (c) **X API keys** — `X_API_*` on `runner` so the growth agent publishes instead of recording.

## First pump.fun launch (mainnet)

Step 2 is done (2026-10-04); the rest is **pending** until the first real launch.

1. Fund the treasury Solana wallet (launch pre-funding, stake refunds, coin burns, refund payouts, Zentro card top-ups) and confirm Anthropic credits.
2. Set `SOLANA_RPC_URL` (keyed mainnet provider) and `SOLANA_CLUSTER=mainnet-beta` on `api` and `runner`, redeploy both; `GET /v1/venues` should report `pump_fun` enabled and `pons_v2` disabled.
3. Sign in on `https://pyre.fun` with Google (a custodial wallet is derived on each chain) and deposit SOL to the custodial Solana address.
4. `/launch`: name, ticker, image, prompt → the intake agent writes a spec → approve it → stake 1 SOL from the custodial balance.
5. The `launch` worker pre-funds the app wallet from the treasury Solana wallet, sends pump.fun `create_v2` and flips the app to `LIVE` (`LAUNCH_GATED` with a 10-minute retry if pump.fun's `createV2Enabled` is off).
6. `feeSweep` collects creator fees every 5 minutes and splits them 60/25/15: 60% to the build budget (half of it as the credits slice), 25% to `COINBURN:<appId>`, 15% to the launcher (paid in ETH on Robinhood Chain).
7. At $50 of accrued budget the scheduler starts the first build; watch it stream on the coin page. The app that deploys is free to use; holding the coin can unlock features inside it.
8. Once `COINBURN:<appId>` holds $5, `buyback` buys the coin from the treasury Solana wallet, burns it with `burnChecked` and sends the `pyre:burn:v1:<sha256 hex>` memo. Record the launch, burn and memo signatures here.

The legacy Robinhood Chain coins need nothing new: their sweeps, builds, trading pages, holders and launcher payouts are unchanged, except that their 25% share is credited to `REFUND` while any refund snapshot holder is still owed (*PYRE → Solana* above).

## Solana venue (pump.fun) — live on mainnet since 2026-10-04

New coins launch on Solana through pump.fun only (`docs/economics.md` → Venues); PONS v2 launches are closed in code. **Decision (owner, 2026-10-04): production went to Solana mainnet directly, without the devnet staging run.** Deployed 2026-10-04; the first real launch's signatures get recorded here once observed. $PYRE's own move to Solana (above) is separate from the app venue; until the Solana PYRE coin launches, only the mint published on pyre.fun is ours.

Procedure in `docs/runbook.md` → Enabling the pump.fun venue.

| Item | State |
| --- | --- |
| Adapter, workers, API, web | in the repo; `pons_v2` closed to launches, every legacy-coin read, trade, sweep, build and payout path kept; the existing suite is the integration gate |
| Prisma migration `20260923000000_multichain` | adds `App.chain` / `App.launchpad` (backfilled `robinhood` / `pons_v2`), `User.solWallet`, `CoinBurn`; runs on the next `prisma migrate deploy` |
| Railway `staging` environment, devnet treasury Solana wallet, devnet integration run, staging product smoke | **skipped** for production by owner decision 2026-10-04 |
| Mainnet: keyed `SOLANA_RPC_URL`, `SOLANA_CLUSTER=mainnet-beta`, `PUMP_LAUNCH_ENABLED=true` on `api` + `runner` | **deployed 2026-10-04**; treasury Solana wallet holds 0 SOL (each launch's 1 SOL stake lands there before the app wallet is pre-funded; burns and refund payouts need SOL above the 0.1 SOL floor) |
| First mainnet launch → claim → burn → memo attest, signatures recorded here (*First pump.fun launch* above) | **pending** |

Facts the first mainnet launch has to confirm, all read from pump.fun's live programs and subject to pump.fun changing them: create costs 0 SOL platform fee plus ≈ 0.005 SOL of rent; the creator earns 30 bps of curve trades and a market-cap-tiered 0.30%–0.95% (declining to 0.05%) on the canonical PumpSwap pool; `collect_creator_fee` / `collect_coin_creator_fee` are permissionless and always pay the recorded creator; mainnet graduates at ≈ 85 SOL raised.
