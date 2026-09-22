# Go-live checklist

Live state of Pyre on Robinhood Chain as of 2026-09-21. Lines marked **pending** have not been run against production yet; nothing below is inferred. Secrets live in `.secrets/pyre-keys.env` (git-ignored) and are set on the Railway services.

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
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | public endpoint; Alchemy recommended (blocked item 4) |
| `CHAIN_ID` | `4663` | |
| `PLATFORM_MASTER_SEED_HEX` | set (new seed) | backed up in `.secrets/pyre-keys.env` |
| treasury (`m/44'/60'/0'/0/0`) | `0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54` | **0 ETH, nonce 0** on chain (blocked item 1) |
| `USDG_ADDRESS` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | |
| `PYRE_TOKEN` / `VITE_PYRE_TOKEN` | unset | `/v1/stats.pyreToken` is `null`; `/pyre` shows the pre-launch state (blocked item 3) |
| `E2B_TEMPLATE` | `pyre-builder` | template built and published |
| `GOOGLE_CLIENT_ID` / `VITE_GOOGLE_CLIENT_ID` | set | |
| `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_WEBHOOK_SECRET` | set | |
| `BLOCKSCOUT_API_KEY` | unset | holders self-index from `Transfer` logs (blocked item 4) |
| `ZENTRO_STATE` | unset | credits slice accrues on `CREDITS:<appId>` ledger only (`credits_accrue_only` on /ops) |
| `X_API_*` | unset | growth posts are recorded as `[X not connected]` |
| `APP_DOMAIN` / `VITE_APP_DOMAIN` | `pyre.fun` | apps serve at `<slug>.pyre.fun` |

## Verified against production

- **Perimeter smoke** (observed): `GET /v1/me` without a token → 401; `POST /v1/rpc` with `eth_sendRawTransaction` → 403 `rpc_method_not_allowed`; `GET /metrics` without the internal secret → 401; `GET /v1/apps` lists and paginates.
- **Runner** (observed in logs): fee sweep, buyback scan, price refresh, holders, growth daily and reconcile passes all tick; reconcile `JOBS`, `SANDBOXES`, `JOBTOKENS`, `LEDGER` (6 checked), `FEES` (3 checked) report clean; an ITERATE build on a demo app ran through sandbox bootstrap on the prebuilt 4 GB `pyre-builder` VM, the agent stage and the reviewer model, which rejected it for spec drift — the pipeline reaches the model and back.
- **Feature matrix** — `railway ssh --service api "node apps/api/scripts/feature-audit.mjs"` (run 2026-09-21 in the api container): **62 passed · 0 failed · 6 blocked on funding · 0 skipped** of 68 features. The six blocked rows are the custodial stake, bounty escrow/payout, top-up, USDG checkout and per-call payment — each reaches its funding gate and refuses cleanly (400/402/502) because the treasury and fixture wallets hold nothing.
- **Perimeter** — `node apps/api/scripts/security-check.mjs https://api.pyre.fun`: **28 passed · 0 failed · 2 skipped** while the `demo` app was hosted (the two skips need `PYRE_GITHUB_SECRET` / `PYRE_PROXY_TOKEN` in the caller's env; both paths are covered by the feature matrix). Since the purge the script's app-origin rows (CSRF on `/_pyre/*`, app cookie flags, app-function rate class) report `404 unknown app` because it targets `/a/demo`; they pass again once any app is hosted. Do not quote a perimeter pass count publicly until then.
- **Web audit** — `node apps/web/scripts/audit.mjs --seed-slug=inboxzero` against `https://api.pyre.fun` (run before the purge; the seed slug no longer exists, so run without `--seed-slug` or point the coin route at `.tmp/mock-api.mjs` on :8787): **all budgets met** — perf 93–100, a11y 100 and 0 console errors on `/`, `/launch`, `/apps`, `/burns`, `/pyre`, `/c/:slug`, `/me`, `/legal/terms`, `/card`; initial JS 160–326 kB; no wallet chunk in any initial graph.
- **Route smoke** — every route on `https://pyre.fun` and the dev build at 1440 and 390 with live data, `scrollWidth === 390` on mobile everywhere, keyboard order and reduced-motion checked (screenshots in `.tmp/real/`, `.tmp/polish/`).
- **Independent reviews** — security review: 1 High (treasury drain via arbitrary stake tx), 5 Medium, 5 Low — all fixed with regression tests; code review: 13 findings (nonce serialisation, $PYRE buyback state machine, market cursor, holders batching, payout confirmation, …) — all fixed.
- **Reconcile in prod** — `JOBS`, `SANDBOXES`, `JOBTOKENS`, `LEDGER`, `FEES`, `PAYOUTS`, `BURNS` clean (the `BURN_TOKEN_NOT_A_CONTRACT` notes went away with the seeded demo tokens).
- **On-chain dry run** (real PONS v2 launch → sweep → buy → burn → attest, hashes recorded here): **pending**, blocked on treasury ETH. Every write path is unit-tested and simulated (`eth_estimateGas` / `simulateContract`) against the live factory; `apps/runner/scripts/launch-pyre.mjs` refuses to run until the treasury is funded.
- **Tests** — `npm test`: 408 passed, 5 skipped (live-chain tests, opt-in with `CHAIN_LIVE_TESTS=1`), ~6 s, no network/DB/Redis/RPC/model access.
- **Build** — `npm run build` green for every package; CI (`.github/workflows/ci.yml`) runs the same sequence on Node 24 plus a migration-drift check.
- **X** — article, pinned post with the launch video, day-1 post and 20 scheduled posts (Sep 22 → Oct 11, 15:00 daily), profile assets and five replies are live under `@PyreFun`; the log is in `marketing/x/pyre/posts/posts.md`.

## Demo content — purged

Production was purged on 2026-09-21: `seed-demo-data.mjs --remove` and `seed-demo-app.mjs demo --remove` were run against the api service, so the public feed, app store, burn ledger and `/v1/stats` show zeros. Nothing on the site is seeded, sampled or projected; the first number to appear will be a real one. The seeding scripts still exist for local and staging work — never run them without `--remove` against production again. `apps/api/scripts/probe-intake.mjs` pushes one real app through the intake queue and reports what the runner did with it.

## Blocked on you

1. **Treasury ETH.** `0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54` holds 0 ETH. It pre-funds every launch (0.0005 ETH fee + gas), pays gas for sweeps, buybacks, burns, attestations, stake refunds and relayed USDG payments, and refuses to act below a 0.01 ETH floor — so nothing on-chain moves until it is funded. Send **~0.05 ETH on Robinhood Chain** (bridge from Arbitrum One or Ethereum, or withdraw directly from an exchange that supports chain 4663). Confirm at `https://robinhoodchain.blockscout.com/address/0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54`. The ops page raises `treasury_low` under 0.02 ETH.
2. **Anthropic credit balance.** The key is set and the reviewer model answered during a production build, but the balance has not been checked. Confirm it in the Anthropic Console and set auto-reload; an empty balance fails every agent call with `credit balance is too low` while E2B sandboxes still bill. If you want builds held until then: `POST /v1/admin/settings { "key": "pause_builds", "value": true }`. To make fees pay for compute afterwards, set the Zentro card as the billing method with auto-reload and set `ZENTRO_STATE` on `runner` (see `docs/runbook.md` → Model-credit funding).
3. **$PYRE launch.** `PYRE_TOKEN` is empty, so the $PYRE share (25% of fees, 10% of revenue) accrues on the `PYRE_TOKEN` ledger without being swapped or burned, staking and platform governance are closed, and `/pyre` shows the pre-launch state. Launch from the treasury after step 1 (procedure in `docs/runbook.md` → Launching $PYRE), then set `PYRE_TOKEN` on `api` and `runner` and `VITE_PYRE_TOKEN` on `web` and redeploy.
4. **Optional keys.** (a) **Alchemy** — create a Robinhood Chain app, set `RPC_URL` on `api` and `runner`; the public RPC is rate-limited per origin and shared by the indexer, price, holders, reconcile and every browser read. (b) **Blockscout API key** — set `BLOCKSCOUT_API_KEY` on `runner` so holder lists come from the explorer instead of self-indexed logs. (c) **X API keys** — `X_API_*` on `runner` so the growth agent publishes instead of recording.

## First real launch

1. Fund the treasury and confirm Anthropic credits.
2. Confirm `/v1/stats` still reports zeros (nothing seeded since the purge).
3. Sign in on `https://pyre.fun` with Google (a custodial wallet is derived) or an external wallet (EIP-191 challenge).
4. `/launch`: name, ticker, image, prompt → the intake agent writes a spec → approve it → stake 0.05 ETH (one click from the custodial balance, or send it to the treasury and submit the tx hash).
5. The `launch` worker pre-funds the app wallet, launches on PONS v2 and flips the app to `LIVE` (`LAUNCH_GATED` with a 10-minute retry if PONS refuses the sender).
6. `feeSweep` claims creator fees every 5 minutes and credits 60% to the build budget (half of it as the credits slice).
7. At $50 of accrued budget the scheduler starts the first build; watch it stream on the coin page.
8. App revenue routes to `buyback`, which buys and burns every 10 minutes and sends the `0x5059524501‖sha256(ids)` attestation from the treasury.
