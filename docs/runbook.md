# Runbook

Operational procedures for Pyre. Commands assume the repo root unless noted.

## Environment

Copy `.env.example` and fill every value. Groups:

- Core: `DATABASE_URL`, `REDIS_URL`, `WEB_ORIGIN`, `API_ORIGIN`, `APP_DOMAIN` (wildcard `*.APP_DOMAIN` → API; leave empty to serve apps at `API_ORIGIN/a/<slug>`), `INTERNAL_SECRET`, `SESSION_SECRET`.
- Privy: `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (server verification), `VITE_PRIVY_APP_ID` (web + generated apps; the only Privy value that reaches a browser).
- Solana: `HELIUS_API_KEY`, `SOLANA_RPC_URL`, `PLATFORM_MASTER_SEED_HEX` (32-byte hex; index 0 = treasury, index N = app N), `PYRE_MINT`, `USDC_MINT`, `HELIUS_WEBHOOK_SECRET`, `HELIUS_WEBHOOK_URL` (runner, used to self-register the Helius webhook), optional `PINATA_JWT`.
- Agents: `ANTHROPIC_API_KEY`, `E2B_API_KEY`, optional `E2B_TEMPLATE`, `GITHUB_TOKEN` (repo scope on `GITHUB_OWNER`), `GITHUB_OWNER`, `GITHUB_WEBHOOK_SECRET`, optional `MODEL_*` overrides.
- Growth: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` (user-context tokens for the platform account, write + read permissions). When empty, posts are recorded to the feed marked "X not connected" and nothing is published.

Generate secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` for `PLATFORM_MASTER_SEED_HEX`, `INTERNAL_SECRET`, `SESSION_SECRET`, `HELIUS_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET` (the latter is read by the API but not yet listed in `.env.example`).

Local dev: `npm install`, `npm run db:generate`, `npm run db:push`, then `npm run dev:api`, `npm run dev:runner`, `npm run dev:web` in separate terminals.

## Railway services

One Railway project with five services:

| Service | Source | Start | Notes |
| --- | --- | --- | --- |
| `postgres` | Railway plugin | — | `DATABASE_URL` |
| `redis` | Railway plugin | — | `REDIS_URL`; BullMQ needs `maxRetriesPerRequest: null` (already set in code) |
| `api` | repo root, build `npm ci && npm run build` | `npm run migrate -w @pyre/db && npm start -w @pyre/api` | public domain `API_ORIGIN` plus wildcard `*.APP_DOMAIN` custom domain; `PORT` from Railway |
| `runner` | repo root, same build | `npm start -w @pyre/runner` | no public domain; needs outbound to E2B, Anthropic, Solana RPC, GitHub, X |
| `web` | repo root, build `npm ci && npm run build -w @pyre/shared -w @pyre/web` | static `apps/web/dist` | SPA fallback to `index.html`; `VITE_*` variables set at build time |

DNS: `A/CNAME` for `WEB_ORIGIN` → web, `API_ORIGIN` → api, `*.APP_DOMAIN` → api. Railway issues wildcard certificates for the custom domain.

Webhooks after deploy:

- Helius: managed by the launch worker. After each successful launch it creates (or updates, id stored in `PlatformSetting.heliusWebhookId`) one enhanced-transactions webhook whose `accountAddresses` are every LIVE/DORMANT app mint, URL `HELIUS_WEBHOOK_URL` (`${API_ORIGIN}/v1/webhooks/helius`), auth header `HELIUS_WEBHOOK_SECRET`. Requires `HELIUS_API_KEY` and `HELIUS_WEBHOOK_URL`; skipped with a log line otherwise. The `holders` job also polls Helius DAS on schedule, so the webhook only speeds up holder updates and scheduler wake-ups.
- GitHub: organization webhook on `GITHUB_OWNER` for `pull_request` events to `${API_ORIGIN}/v1/webhooks/github`, secret `GITHUB_WEBHOOK_SECRET` (`X-Hub-Signature-256`).

Health: `GET ${API_ORIGIN}/health`; runner logs `worker registered` lines at boot. Ops dashboard: `${WEB_ORIGIN}/ops` (admin users only; set `User.isAdmin = true` by SQL for the first admin).

## Funding the treasury

The treasury is `deriveAppKeypair(PLATFORM_MASTER_SEED_HEX, 0)`. Print its address with:

`node -e "import('@pyre/chain').then(c => console.log(c.treasuryKeypair().publicKey.toBase58()))"` from `apps/runner` after a build.

Keep it funded with SOL for: buyback swaps (revenue is received in USDC, swaps are paid in SOL), stake refunds when the app wallet is short, bounty payouts, and rent for token accounts. Alert when the balance is under 2 SOL. USDC revenue accumulates in the treasury's USDC ATA; convert to SOL periodically through the same Jupiter path or leave it as the ops reserve.

## Launching $PYRE

1. Fund the treasury with at least 0.1 SOL.
2. Run the launch through the normal path with the treasury as creator: `launchPumpToken({ creator: treasuryKeypair(), name: "Pyre", symbol: "PYRE", uri })` where `uri` is a pump.fun-style metadata JSON on IPFS (`PINATA_JWT`) or any public HTTPS URL.
3. Set `PYRE_MINT` and `VITE_SHIP_MINT`, redeploy api, runner, web.
4. The `PYRE_TOKEN` ledger balance becomes spendable: the buyback worker starts routing it into $PYRE purchases once the mint is set. Staking (`/ship`) requires the mint to be set.

## Rotating keys

- `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `GITHUB_TOKEN`, `HELIUS_API_KEY`, `X_*`: update the Railway variable, redeploy the affected service. In-flight build jobs finish on the old sandbox; job tokens are unaffected (they are platform-issued, not the vendor key).
- `SESSION_SECRET`: rotating logs every app user out of every app (cookies fail HMAC). Do it during low traffic.
- `INTERNAL_SECRET`, `HELIUS_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET`: rotate both sides (Railway variable and the provider's webhook config) in the same change.
- `PLATFORM_MASTER_SEED_HEX`: **cannot be rotated in place** — every app's creator wallet is derived from it and is the pump.fun coin creator. If it leaks: set `pauseFeeSweep` and `pauseBuyback`, sweep every app wallet and the treasury to a fresh treasury derived from a new seed, then update `App.creatorWallet` rows and the seed together. Creator-fee claims for existing coins remain bound to the old keys, so treat a leak as a full incident.
- Privy secrets: rotate in the Privy dashboard, update `PRIVY_APP_SECRET`; the app id is public.

## Kill switch

`POST /v1/admin/apps/:id/kill { reason }` as an admin. Effects: `App.status = KILLED`, `killedReason` set, the app origin serves a 410 page, queued BuildJobs are cancelled and removed from BullMQ, running jobs are cancelled and their JobToken revoked (the runner aborts the sandbox), growth stops, the coin page shows the killed state. Fees already accrued stay in the ledger; `feeSweep` skips killed apps so new creator fees stay in the pump vaults / creator wallet. Reverse with `POST /v1/admin/apps/:id/unkill` (→ `LIVE`, or `DRAFT` if it never launched).

Platform-wide pauses are `PlatformSetting` rows set with `POST /v1/admin/settings { "key", "value" }`; a value of `true` pauses, anything else resumes:

- `pause_builds` — the scheduler creates no new BuildJobs and the build worker delays already-queued jobs by 15 minutes.
- `pauseFeeSweep` — no creator-fee collection or splits.
- `pauseBuyback` — no swaps or burns; `pendingRevenueMicros` keeps accumulating.

Only keys a worker reads have any effect.

Global compute: if `DailyComputeSpend` for today approaches `GLOBAL_DAILY_COMPUTE_CEILING_USD` the runner refuses new jobs automatically; raise the constant only with a deploy.

## DMCA flow

1. Notice arrives (email to the designated agent, or `POST /v1/reports` with `kind: "DMCA"`). Confirm it names the work, the infringing URL (`https://<slug>.<APP_DOMAIN>` or the repo), and includes a good-faith statement and signature.
2. Within one business day: `POST /v1/admin/apps/:id/kill` with reason `DMCA <report id>` and mark the report actioned (`POST /v1/admin/reports/:id { status: "ACTIONED" }`). Kill also stops builds so the agent cannot re-deploy the material.
3. Notify the launcher (email on file via Privy or the X handle) with the notice and counter-notice instructions.
4. Counter-notice: forward to the claimant; if no court action within 10–14 business days, `unkill` and let the launcher (or a prompt-queue task) remove the material before the next deploy.
5. Repeat infringers: ban the user (`User.bannedAt`) which blocks new launches.

## Restoring a dormant app

An app is `DORMANT` when `budgetMicros` hit 0 with no pending revenue. Ways back to `LIVE`:

- Organic: any swept creator fee revives it; the scheduler flips status and emits `REVIVED`.
- Holder top-up: `POST /v1/apps/:slug/topup { txSignature }` after sending SOL to `App.creatorWallet`; 100% of it becomes budget (`FeeEvent.source = REVIVE_BUY`).
- Ops credit: insert a `FeeEvent` with `source = MANUAL` and matching `LedgerEntry` on `BUILD:<appId>`, then set `App.budgetMicros`; the next scheduler tick revives the app. Use for incidents where a platform bug burned budget.

After revival the growth worker posts a revive announcement if `growthEnabled` and budget ≥ $2. If the app was also unhealthy, the monitor's next check enqueues `SELF_HEAL` with the last error.
