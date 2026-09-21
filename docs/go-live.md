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
| `CREDITS_FUNDING_WALLET` | unset | credits slice accrues on `CREDITS:<appId>` ledger only |
| `X_API_*` | unset | growth posts are recorded as `[X not connected]` |
| `APP_DOMAIN` / `VITE_APP_DOMAIN` | `pyre.fun` | apps serve at `<slug>.pyre.fun` |

## Verified against production

- **Perimeter smoke** (observed): `GET /v1/me` without a token → 401; `POST /v1/rpc` with `eth_sendRawTransaction` → 403 `rpc_method_not_allowed`; `GET /metrics` without the internal secret → 401; `GET /v1/apps` lists and paginates.
- **Runner** (observed in logs): fee sweep, buyback scan, price refresh, holders, growth daily and reconcile passes all tick; reconcile `JOBS`, `SANDBOXES`, `JOBTOKENS`, `LEDGER` (6 checked), `FEES` (3 checked) report clean; an ITERATE build on a demo app ran through sandbox bootstrap on the prebuilt 4 GB `pyre-builder` VM, the agent stage and the reviewer model, which rejected it for spec drift — the pipeline reaches the model and back.
- **Feature matrix** — `railway ssh --service api "node apps/api/scripts/feature-audit.mjs"`: **pending**.
- **Perimeter** — `apps/api/scripts/security-check.mjs https://api.pyre.fun`: **pending**.
- **Web audit** — `node apps/web/scripts/audit.mjs` against `https://api.pyre.fun` (perf, a11y 100, no console errors, 1440 and 390): **pending**.
- **Route smoke** — every route on `https://pyre.fun` at 1440 and 390 with live data: **pending**.
- **Reconcile 0 drift in prod** — blocked on purging the demo rows (below): `BURNS` currently reports `BURN_SUPPLY_UNREADABLE` because the three seeded token addresses are not contracts on this chain.
- **On-chain dry run** (real PONS v2 launch of a throwaway coin → sweep → buy → burn → attest, hashes recorded here): **pending**, blocked on treasury ETH.
- **Tests** — `npm test`: 349 passed, 5 skipped, ~6 s, no network/DB/Redis/RPC/model access.
- **Build** — `npm run build` green for every package; CI (`.github/workflows/ci.yml`) runs the same sequence on Node 24 plus a migration-drift check.

## Demo content — remove before public launch

Three seeded apps (`inboxzero`, `shotcaller`, `deadlinks`) carry **fake revenue, buybacks and feed events** so the UI could be built and verified against realistic content. They are on the public feed right now and their wallets were seeded under a different seed, so every fee-sweep pass logs `derived wallet … does not match App.walletAddress` for them and every buyback pass fails on the empty treasury. Purge before you show the site to anyone:

```
railway ssh --service api "node apps/api/scripts/seed-demo-data.mjs --remove"
railway ssh --service api "node apps/api/scripts/seed-demo-app.mjs demo --remove"
```

Re-seed at any time with the same scripts minus `--remove`. `apps/api/scripts/probe-intake.mjs` pushes one real app through the intake queue and reports what the runner did with it.

## Blocked on you

1. **Treasury ETH.** `0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54` holds 0 ETH. It pre-funds every launch (0.0005 ETH fee + gas), pays gas for sweeps, buybacks, burns, attestations, stake refunds and relayed USDG payments, and refuses to act below a 0.01 ETH floor — so nothing on-chain moves until it is funded. Send **~0.05 ETH on Robinhood Chain** (bridge from Arbitrum One or Ethereum, or withdraw directly from an exchange that supports chain 4663). Confirm at `https://robinhoodchain.blockscout.com/address/0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54`. The ops page raises `treasury_low` under 0.02 ETH.
2. **Anthropic credit balance.** The key is set and the reviewer model answered during a production build, but the balance has not been checked. Confirm it in the Anthropic Console and set auto-reload; an empty balance fails every agent call with `credit balance is too low` while E2B sandboxes still bill. If you want builds held until then: `POST /v1/admin/settings { "key": "pause_builds", "value": true }`. To make fees pay for compute afterwards, set `CREDITS_FUNDING_WALLET` to the deposit address of the card that bills Anthropic (see `docs/runbook.md`).
3. **$PYRE launch.** `PYRE_TOKEN` is empty, so the $PYRE share (25% of fees, 10% of revenue) accrues on the `PYRE_TOKEN` ledger without being swapped or burned, staking and platform governance are closed, and `/pyre` shows the pre-launch state. Launch from the treasury after step 1 (procedure in `docs/runbook.md` → Launching $PYRE), then set `PYRE_TOKEN` on `api` and `runner` and `VITE_PYRE_TOKEN` on `web` and redeploy.
4. **Optional keys.** (a) **Alchemy** — create a Robinhood Chain app, set `RPC_URL` on `api` and `runner`; the public RPC is rate-limited per origin and shared by the indexer, price, holders, reconcile and every browser read. (b) **Blockscout API key** — set `BLOCKSCOUT_API_KEY` on `runner` so holder lists come from the explorer instead of self-indexed logs. (c) **X API keys** — `X_API_*` on `runner` so the growth agent publishes instead of recording.

## First real launch

1. Fund the treasury and confirm Anthropic credits.
2. Purge the demo content.
3. Sign in on `https://pyre.fun` with Google (a custodial wallet is derived) or an external wallet (EIP-191 challenge).
4. `/launch`: name, ticker, image, prompt → the intake agent writes a spec → approve it → stake 0.002 ETH (one click from the custodial balance, or send it to the treasury and submit the tx hash).
5. The `launch` worker pre-funds the app wallet, launches on PONS v2 and flips the app to `LIVE` (`LAUNCH_GATED` with a 10-minute retry if PONS refuses the sender).
6. `feeSweep` claims creator fees every 5 minutes and credits 60% to the build budget (half of it as the credits slice).
7. At $50 of accrued budget the scheduler starts the first build; watch it stream on the coin page.
8. App revenue routes to `buyback`, which buys and burns every 10 minutes and sends the `0x5059524501‖sha256(ids)` attestation from the treasury.
