# Runbook

Operational procedures for Pyre. Commands assume the repo root unless noted.

## Environment

Copy `.env.example` and fill every value. Groups, in the order the file lists them:

- **Core**: `DATABASE_URL`, `REDIS_URL`, `WEB_ORIGIN`, `API_ORIGIN`, `APP_DOMAIN` (wildcard `*.APP_DOMAIN` → API; leave empty to serve apps at `API_ORIGIN/a/<slug>`), `INTERNAL_SECRET` (bearer for `/metrics`), `SESSION_SECRET` (signs platform session JWTs and per-app host cookies), `LOG_LEVEL`, `PORT`.
- **Auth**: `GOOGLE_CLIENT_ID` (Google Identity Services; the same client id is exposed to the web app and to hosted apps as `VITE_GOOGLE_CLIENT_ID` / `window.__PYRE__.googleClientId`). Wallet sign-in needs nothing extra — it is an EIP-191 challenge verified server-side.
- **Robinhood Chain**: `RPC_URL` (the public `https://rpc.mainnet.chain.robinhood.com` is rate-limited and has no websocket; use an Alchemy Robinhood Chain app URL in production), `RPC_WSS_URL` (optional, Alchemy), `CHAIN_ID=4663`, `PLATFORM_MASTER_SEED_HEX` (16–64 bytes hex; users derive at `m/44'/60'/0'/0/<walletIndex>`, treasury = index 0; apps derive at `m/44'/60'/1'/0/<keypairIndex>`), `TREASURY_WALLET` (informational), `PYRE_TOKEN` (empty until launched), `LAUNCH_STAKE_WEI` (override; default 0.002 ETH), `USDG_ADDRESS`, `PONS_FACTORY` / `PONS_LAUNCH_AND_BUY` / `PONS_FEE_ESCROW` / `PONS_MEME_HOOK`, `UNIV4_POOL_MANAGER` / `UNIV4_UNIVERSAL_ROUTER` / `UNIV4_QUOTER` / `UNIV4_STATE_VIEW`, `BLOCKSCOUT_URL`, `BLOCKSCOUT_API_KEY` (optional), `CREDITS_FUNDING_WALLET` (optional), `GITHUB_WEBHOOK_SECRET`.
- **Agents**: `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `E2B_TEMPLATE` (`pyre-builder`; falls back to `base`), `GITHUB_TOKEN` (repo scope on `GITHUB_OWNER`), `GITHUB_OWNER`, optional `MODEL_ROUTINE` / `MODEL_ARCHITECT` / `MODEL_REVIEWER` overrides.
- **Growth**: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` (user-context tokens for the platform account). When empty, posts are recorded to the feed marked "X not connected" and nothing is published.
- **Web** (build-time, `VITE_` prefixed): `VITE_API_ORIGIN`, `VITE_GOOGLE_CLIENT_ID`, `VITE_APP_DOMAIN`, `VITE_PYRE_TOKEN`, `VITE_CHAIN_ID`, `VITE_EXPLORER_URL`.

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` for `PLATFORM_MASTER_SEED_HEX`, `INTERNAL_SECRET`, `SESSION_SECRET` and `GITHUB_WEBHOOK_SECRET`.

Local dev: `npm install`, `npm run db:generate`, `npm run db:push`, then `npm run dev:api`, `npm run dev:runner`, `npm run dev:web` in separate terminals. Open the web app as `http://localhost:5173` (not `127.0.0.1`) so CORS matches `WEB_ORIGIN`.

## Railway

Project **`pyre`** (id `33701d8a-7fa9-4255-8640-d508c174af14`, environment `production`), five services:

| Service | Source | Start | Notes |
| --- | --- | --- | --- |
| `Postgres` | Railway plugin | — | `DATABASE_URL`; volume `postgres-volume` |
| `Redis` | Railway plugin | — | `REDIS_URL`; volume `redis-volume`; BullMQ needs `maxRetriesPerRequest: null` (set in code) |
| `api` | `apps/api/Dockerfile` (`RAILWAY_DOCKERFILE_PATH`) | `npx prisma migrate deploy … && node apps/api/dist/index.js` | health check `/health` (120 s); custom domains `api.pyre.fun` + `*.pyre.fun`; `PORT` 8080 |
| `runner` | `apps/runner/Dockerfile` | `node apps/runner/dist/index.js` | no public domain; restart `ALWAYS`; needs outbound to E2B, Anthropic, the RPC, Blockscout, GitHub, X |
| `web` | `apps/web/Dockerfile` | `node server.mjs` (sirv + SPA fallback, `/healthz`) | custom domain `pyre.fun`; `VITE_*` are build args, so a variable change needs a redeploy |

Deploy with `railway up --service <api|runner|web> --ci` from the repo root. Read logs with `railway logs --service <name>`; run one-off scripts with `railway ssh --service api "node apps/api/scripts/<script>.mjs"`.

### DNS (Porkbun, `pyre.fun`)

Records already created:

| Type | Host | Value | Purpose |
| --- | --- | --- | --- |
| ALIAS | `@` | `qok06i6z.up.railway.app` | web |
| CNAME | `api` | `ee3pjfqz.up.railway.app` | api |
| CNAME | `*` | `pyagq8qz.up.railway.app` | hosted apps (`<slug>.pyre.fun`) |
| TXT | `_railway-verify` | `railway-verify=…` | domain ownership |
| TXT | `_acme-challenge` | (per Railway) | wildcard certificate issuance |

Railway issues and renews the certificates, including the wildcard. Reserved subdomains that can never become an app: `www api app apps admin assets static cdn mail ftp ns mx` (host resolver) and `www api app admin pyre ship static assets mail docs status cdn dev` (slugs).

### Health

`GET https://api.pyre.fun/health` → `{"ok":true}` (checks Postgres + Redis); `GET https://pyre.fun/healthz` → `ok`; runner logs `runner started` with the 13 queue names at boot and `chain workers registered`. Public dependency status: `GET /v1/status`, rendered at `https://pyre.fun/status`. Ops dashboard: `https://pyre.fun/ops` (admin users only; set `User.isAdmin = true` by SQL for the first admin). Prometheus: `GET /metrics` with `Authorization: Bearer $INTERNAL_SECRET`.

## Treasury

The treasury is user index 0 of `PLATFORM_MASTER_SEED_HEX`: **`0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54`**. The seed is backed up in `.secrets/pyre-keys.env` (git-ignored) — losing it loses every custodial user wallet and every app wallet. Print the address from a built runner with:

```
node -e "import('@pyre/chain').then(c => console.log(c.treasury().address))"
```

(`PLATFORM_MASTER_SEED_HEX` must be in the environment.)

### Funding

Keep the treasury in ETH on Robinhood Chain. It pays for: pre-funding each app wallet with the PONS launch fee (0.0005 ETH) + gas at launch, gas top-ups for fee sweeps, buyback swaps (revenue is received in USDG; buys are paid in ETH at the current price), burn and attestation gas, stake refunds, bounty payouts, credits-funding swaps, and gas for relayed USDG authorizations. Every spending path refuses to take the balance below `TREASURY_FLOOR_WEI` (0.01 ETH) and retries next cycle, so an empty treasury degrades to "nothing moves" rather than to a broken state. ~0.05 ETH covers dozens of launches and sweeps at current gas; alert under 0.02 ETH.

Bridge ETH from Arbitrum One or Ethereum with the Robinhood Chain bridge, or send from any exchange that supports the chain directly, to the address above. Confirm on Blockscout: `https://robinhoodchain.blockscout.com/address/0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54`.

USDG revenue accumulates in the treasury; it is the ops reserve and is never automatically converted.

### RPC

Production runs on the public RPC by default. It is rate-limited per origin and the market indexer, price refresh, holders indexer, reconcile and browser reads (`POST /v1/rpc`) all share it. Create an Alchemy app for Robinhood Chain, set `RPC_URL=https://<app>.g.alchemy.com/v2/<key>` on `api` and `runner` (never on `web` — the browser only ever talks to `/v1/rpc`), optionally `RPC_WSS_URL`, and redeploy both.

### Blockscout API key

Without `BLOCKSCOUT_API_KEY` the holders worker self-indexes ERC-20 `Transfer` logs through the RPC (bounded chunks per pass, so a busy coin's holder list lags). With a key it reads the Blockscout holders endpoint directly and never replaces a populated snapshot with an empty one. Request a key at `https://robinhoodchain.blockscout.com` (account → API keys), set it on `runner`, redeploy.

## E2B template

`E2B_TEMPLATE=pyre-builder` is built and set in production. Rebuild after changing `template/`, the app SDK, or the in-sandbox runner:

```
npx tsx apps/runner/scripts/build-e2b-template.ts pyre-builder
```

Builds server-side (no Docker), ~2 min, needs `E2B_API_KEY`. The stock `base` template still works as a fallback but is far slower and memory-starved.

## Launching $PYRE

$PYRE is an ordinary PONS v2 launch whose creator is the treasury, so its creator fees flow to the treasury and `feeSweep` claims them as platform fees (`sweepPlatformFees`).

1. Fund the treasury (≥ 0.01 ETH above the floor: the launch fee is 0.0005 ETH plus gas).
2. From a shell with the production env (`railway ssh --service runner`), launch with the treasury account:

   ```
   node -e "import('@pyre/chain').then(async c => {
     const t = c.treasury();
     const r = await c.launchPonsToken(t.account, {
       name: 'Pyre', symbol: 'PYRE',
       logo: 'https://pyre.fun/icon-512.png',
       description: 'the coin that funds every app on pyre.fun and burns with their revenue',
       socials: { website: 'https://pyre.fun', twitter: '<x profile url>' },
       creatorFeeRecipient: t.address,
     });
     console.log(r);
   })"
   ```

   The result contains `hash`, `token` and `curve`. If it throws `LaunchGatedError`, PONS's public gate is closed for that sender; retry later or ask PONS to whitelist the treasury.
3. Set `PYRE_TOKEN=<token>` on `api` and `runner`, `VITE_PYRE_TOKEN=<token>` on `web`, redeploy all three.
4. From the next passes on: `feeSweep` claims $PYRE creator fees to the treasury, `buyback` swaps the `PYRE_TOKEN` ledger balance (25% of every app's fees + 10% of every app's revenue) into $PYRE and burns it whenever it clears $5, staking (`POST /v1/pyre/stake`) and platform governance open, and `/pyre` leaves its pre-launch state.

## Rotating keys

- `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `GITHUB_TOKEN`, `BLOCKSCOUT_API_KEY`, `X_*`: update the Railway variable, redeploy the affected service. In-flight build jobs finish on the old sandbox; job tokens are unaffected (they are platform-issued, not the vendor key).
- `SESSION_SECRET`: rotating logs every user out of the platform and every app user out of every app (JWTs and host cookies fail verification). Do it during low traffic.
- `INTERNAL_SECRET`, `GITHUB_WEBHOOK_SECRET`: rotate both sides (Railway variable and the consumer — Prometheus scraper / GitHub webhook config) in the same change.
- `GOOGLE_CLIENT_ID`: create the new OAuth client with the same authorized JavaScript origins, set it on `api` and as `VITE_GOOGLE_CLIENT_ID` on `web`, redeploy both.
- `PLATFORM_MASTER_SEED_HEX`: **cannot be rotated in place** — every custodial user balance, every app wallet and every PONS `creatorFeeRecipient` is derived from it. If it leaks: set `pauseFeeSweep`, `pauseBuyback` and `pause_builds`, disable withdrawals by taking the API down if necessary, sweep every user and app wallet and the treasury to a fresh treasury derived from a new seed, then update `User.wallet` / `App.walletAddress` rows and the seed together. Creator-fee claims for already-launched coins remain bound to the old app keys (PONS records the recipient at launch), so treat a leak as a full incident.

## Kill switches

`POST /v1/admin/apps/:id/kill { reason }` as an admin. Effects: `App.status = KILLED`, `killedReason` set, the app origin serves a 410 page, queued BuildJobs are cancelled and removed from BullMQ, running jobs are cancelled and their JobToken revoked (the runner aborts the sandbox), growth stops, the coin page shows the killed state. Fees already accrued stay in the ledger; `feeSweep` and `buyback` only visit `LIVE`/`DORMANT` apps, so new creator fees keep accruing on the curve or hook unclaimed. Reverse with `POST /v1/admin/apps/:id/unkill` (→ `LIVE`, or `DRAFT` if it never launched).

Platform-wide pauses are `PlatformSetting` rows set with `POST /v1/admin/settings { "key", "value" }`; a value of `true` pauses, anything else resumes:

- `pause_builds` — the scheduler creates no new BuildJobs and the build worker delays already-queued jobs by 15 minutes.
- `pauseFeeSweep` — no sweeps, claims, splits, stake refunds or credits funding.
- `pauseBuyback` — no swaps, burns or attestations; `pendingRevenueMicros` keeps accumulating.

Only keys a worker reads have any effect.

Global compute: if `DailyComputeSpend` for today approaches `GLOBAL_DAILY_COMPUTE_CEILING_USD` ($2 000) the runner refuses new jobs and the Anthropic proxy answers 429; raise the constant only with a deploy.

## Reconcile

The `reconcile` worker runs seven checks every 5 minutes and writes one `ReconcileRun` row per check (visible on `/ops`): `JOBS`, `SANDBOXES`, `JOBTOKENS` (repair: settle dead builds, kill orphaned sandboxes, revoke spent tokens), `PAYOUTS` (repair: a treasury payout the API broadcast but could not confirm — fee claim, unstake, staker rewards, bounty — is settled from its receipt: ledger/status finalised on success, funds released on revert; `PAYOUT_DROPPED` means an hour with no receipt), `LEDGER` (report: budget vs ledger, buybacks vs revenue, fee-split sums), `FEES` (repair: escrow `Claimed` logs with no `FeeEvent` are replayed; app wallets holding unswept ETH are reported), `BURNS` (report: `Buyback.burnedUnits` and `PyreBurn.burnedUnits` vs the on-chain supply reduction; `PYRE_BURN_STUCK` is a $PYRE burn parked in SWAPPING/SWAPPED for over 30 minutes — check `PyreBurn.error` and the swap tx before touching it, the ledger debit is already written). `drifted > 0` on `LEDGER`, `BURNS` or `PAYOUTS` needs a human; on `FEES` it usually means the runner was down while claims happened and has already been repaired. `BURN_SUPPLY_UNREADABLE` means an `App.tokenAddress` is not an ERC-20 on this chain — expected only for seeded demo rows.

There is no ad-hoc trigger; a pass runs on the next tick (≤ 5 min).

## DMCA flow

1. Notice arrives (`dmca@pyre.fun`, the address published in the content policy, or `POST /v1/reports` with `kind: "DMCA"`). Confirm it names the work, the infringing URL (`https://<slug>.pyre.fun` or the `pyre-<slug>` repo), and includes a good-faith statement and signature.
2. Within one business day: `POST /v1/admin/apps/:id/kill` with reason `DMCA <report id>` and mark the report actioned (`POST /v1/admin/reports/:id { status: "ACTIONED" }`). Kill also stops builds so the agent cannot re-deploy the material.
3. Notify the launcher with the notice and counter-notice instructions. No email is stored: use the in-app notification and, if set, the X handle on the account (`User.xHandle`).
4. Counter-notice: forward to the claimant; if no court action within 10–14 business days, `unkill` and let the launcher (or a prompt-queue task) remove the material before the next deploy.
5. Repeat infringers: ban the user (`User.bannedAt`), which blocks sign-in and new launches.

## Restoring a dormant app

An app is `DORMANT` when `budgetMicros` fell under $10 with no pending revenue. Ways back to `LIVE`:

- Organic: any swept creator fee that lifts the budget to ≥ $10 revives it; `feeSweep` flips status and emits `REVIVED`.
- Holder top-up: `POST /v1/apps/:slug/topup { eth }` sends ETH from the caller's custodial wallet to `App.walletAddress`; 100% of it becomes budget (`FeeEvent.source = REVIVE_BUY`) and the status flips immediately.
- Ops credit: insert a `FeeEvent` with `source = MANUAL` and matching `LedgerEntry` on `BUILD:<appId>`, then set `App.budgetMicros`; the next scheduler tick revives the app. Use for incidents where a platform bug burned budget.

After revival the growth worker posts a revive announcement if `growthEnabled` and budget ≥ $2. If the app was also unhealthy, the monitor's next check enqueues `SELF_HEAL` with the last error.

## Launch gated

`LAUNCH_GATED` means `factory.canLaunch(appWallet)` returned false: PONS closed public launches or removed the sender from its whitelist. The app keeps its stake, the launcher gets a notification, and the `launch` worker retries every gated app every 10 minutes. Nothing to do unless it persists for hours — then ask PONS. If the gate is permanent, refund the stake by hand from the treasury and set the app `FAILED`.
