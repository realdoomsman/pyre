# Runbook

Operational procedures for Pyre. Commands assume the repo root unless noted.

## Environment

Copy `.env.example` and fill every value. Groups, in the order the file lists them:

- **Core**: `DATABASE_URL`, `REDIS_URL`, `WEB_ORIGIN`, `API_ORIGIN`, `APP_DOMAIN` (wildcard `*.APP_DOMAIN` → API; leave empty to serve apps at `API_ORIGIN/a/<slug>`), `INTERNAL_SECRET` (bearer for `/metrics`), `SESSION_SECRET` (signs platform session JWTs and per-app host cookies), `LOG_LEVEL`, `PORT`.
- **Auth**: `GOOGLE_CLIENT_ID` (Google Identity Services; the same client id is exposed to the web app and to hosted apps as `VITE_GOOGLE_CLIENT_ID` / `window.__PYRE__.googleClientId`). Wallet sign-in needs nothing extra — it is an EIP-191 challenge verified server-side.
- **Robinhood Chain**: `RPC_URL` (the public `https://rpc.mainnet.chain.robinhood.com` is rate-limited and has no websocket; use an Alchemy Robinhood Chain app URL in production), `RPC_WSS_URL` (optional, Alchemy), `CHAIN_ID=4663`, `PLATFORM_MASTER_SEED_HEX` (16–64 bytes hex; users derive at `m/44'/60'/0'/0/<walletIndex>`, treasury = index 0; apps derive at `m/44'/60'/1'/0/<keypairIndex>`), `TREASURY_WALLET` (informational), `PYRE_TOKEN` (empty until launched), `LAUNCH_STAKE_WEI` (override; default 0.05 ETH), `USDG_ADDRESS`, `PONS_FACTORY` / `PONS_LAUNCH_AND_BUY` / `PONS_FEE_ESCROW` / `PONS_MEME_HOOK`, `UNIV4_POOL_MANAGER` / `UNIV4_UNIVERSAL_ROUTER` / `UNIV4_QUOTER` / `UNIV4_STATE_VIEW`, `BLOCKSCOUT_URL`, `BLOCKSCOUT_API_KEY` (optional), `ZENTRO_STATE` (optional, runner only; see Model-credit funding), `GITHUB_WEBHOOK_SECRET`.
- **Solana / pump.fun** (all optional; the venue does not exist until `SOLANA_RPC_URL` is set): `SOLANA_RPC_URL` (HTTPS JSON-RPC; the public `api.mainnet-beta.solana.com` often cannot send transactions — use a Helius or QuickNode URL in production, `https://api.devnet.solana.com` or a keyed devnet URL on staging), `SOLANA_CLUSTER` (`mainnet-beta` | `devnet`; picks pump.fun's devnet deployment, explorer `?cluster=devnet` links and the devnet curve parameters), `SOLANA_WSS_URL` (optional websocket for the same provider), `PUMP_LAUNCH_ENABLED` (default `true` when the RPC is set; `false` hides the venue from `/v1/venues` and the launch picker without unsetting the RPC, so existing Solana coins keep sweeping, trading and burning). Solana keys derive from the same `PLATFORM_MASTER_SEED_HEX`: users at SLIP-0010 ed25519 `m/44'/501'/<walletIndex>'/0'`, treasury = index 0; apps at `m/44'/501'/<1000000 + keypairIndex>'/0'`. Set the same values on `api` and `runner`; never on `web` (the browser never talks to a Solana RPC).
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
| `runner` | `apps/runner/Dockerfile` | `node apps/runner/dist/index.js` | no public domain; restart `ALWAYS`; needs outbound to E2B, Anthropic, the RPC, Blockscout, GitHub, X, zentro.finance and api.relay.link; image ships headless Chromium |
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

The treasury is user index 0 of `PLATFORM_MASTER_SEED_HEX`, on both chains. Robinhood Chain: **`0xdd9F2043c2df2Cd675ff4eF75373E82bB68389b6`**. Solana: the ed25519 key at `m/44'/501'/0'/0'` of the same seed — the **treasury Solana wallet**. The seed is backed up in `.secrets/pyre-keys.env` (git-ignored) — losing it loses every custodial user wallet and every app wallet on both chains. Print the addresses from a built runner with:

```
node -e "import('@pyre/chain').then(c => console.log(c.treasury().address))"
node -e "import('@pyre/chain').then(c => console.log(c.adapterFor('pump_fun').treasury().address))"
```

(`PLATFORM_MASTER_SEED_HEX` must be in the environment.)

### Funding

Keep the treasury in ETH on Robinhood Chain. It pays for: pre-funding each Robinhood app wallet with the PONS launch fee (0.0005 ETH) + gas at launch, gas top-ups for fee sweeps, the $PYRE buyback swap (the 25% fee share is ledgered in USD; the buy is paid in ETH at the current price), burn and attestation gas, ETH stake refunds, **launcher payouts for coins on either chain** (the `LAUNCHER:` ledger is USD micros and is always paid in ETH on Robinhood Chain), bounty payouts, and credit top-ups (ETH → USDC on Ethereum via Relay). Every spending path refuses to take the balance below `TREASURY_FLOOR_WEI` (0.01 ETH) and retries next cycle, so an empty treasury degrades to "nothing moves" rather than to a broken state. ~0.05 ETH covers dozens of launches and sweeps at current gas; alert under 0.02 ETH.

Keep the treasury Solana wallet in SOL when the pump.fun venue is on. It pays for: pre-funding each Solana app wallet with `predictLaunchCost` (≈ 0.005 SOL of rent; pump.fun charges nothing to create) plus a gas float, the coin-burn buys (`COINBURN:<appId>` is ledgered in USD; each buy is paid in SOL at the current price), burn + memo transaction fees (5 000 lamports a signature plus a priority fee), and SOL stake refunds (1 SOL each — the largest single outflow, so hold at least one stake's worth per app awaiting its first build). It never pays launchers. A $5 buyback costs about 0.043 SOL plus ≈ 0.003 SOL of one-off account rent per coin. ~0.5 SOL covers dozens of launches and burns; alert under 0.1 SOL plus outstanding stakes.

Bridge ETH from Arbitrum One or Ethereum with the Robinhood Chain bridge, or send from any exchange that supports the chain directly, to the address above. Confirm on Blockscout: `https://robinhoodchain.blockscout.com/address/0xdd9F2043c2df2Cd675ff4eF75373E82bB68389b6`. Send SOL from any exchange or wallet to the treasury Solana wallet on Solana mainnet (devnet SOL for staging comes from a faucet, see *Enabling the pump.fun venue*) and confirm on Solscan: `https://solscan.io/account/<address>` (`?cluster=devnet` on staging).

Claimed creator fees land in the treasury in the coin's native asset: ETH on Robinhood Chain, SOL in the treasury Solana wallet. The launcher and staker shares are paid out of the Robinhood treasury in ETH on claim, the build and credits shares are spent from it, the $PYRE share is swapped and burned from it, and each Solana coin's burn share is swapped and burned from the treasury Solana wallet. Nothing is bridged between the two.

### RPC

Production runs on the public RPC by default. It is rate-limited per origin and the market indexer, price refresh, holders indexer, reconcile and browser reads (`POST /v1/rpc`) all share it. Create an Alchemy app for Robinhood Chain, set `RPC_URL=https://<app>.g.alchemy.com/v2/<key>` on `api` and `runner` (never on `web` — the browser only ever talks to `/v1/rpc`), optionally `RPC_WSS_URL`, and redeploy both.

### Blockscout API key

Without `BLOCKSCOUT_API_KEY` the holders worker self-indexes ERC-20 `Transfer` logs through the RPC (bounded chunks per pass, so a busy coin's holder list lags). With a key it reads the Blockscout holders endpoint directly and never replaces a populated snapshot with an empty one. Request a key at `https://robinhoodchain.blockscout.com` (account → API keys), set it on `runner`, redeploy.

### Solana RPC

`SOLANA_RPC_URL` is shared by the pump.fun launch, fee claims, coin burns, the trade indexer (`getSignaturesForAddress` + `getTransaction` per coin every 60 s), holders (`getTokenLargestAccounts`) and price reads. The public endpoint rate-limits and frequently refuses `sendTransaction`; use a Helius (free tier: 10 rps, 1 rps `sendTransaction`) or QuickNode URL on `api` and `runner`, optionally `SOLANA_WSS_URL`, and redeploy both. The browser never sees it.

## E2B template

`E2B_TEMPLATE=pyre-builder` is built and set in production. Rebuild after changing `template/`, the app SDK, or the in-sandbox runner:

```
npx tsx apps/runner/scripts/build-e2b-template.ts pyre-builder
```

Builds server-side (no Docker), ~2 min, needs `E2B_API_KEY`. The stock `base` template still works as a fallback but is far slower and memory-starved.

## Launching $PYRE

$PYRE is an ordinary PONS v2 launch whose creator is the treasury, so its creator fees flow to the treasury and `feeSweep` claims them as platform fees (`sweepPlatformFees`). It is launched once, on Robinhood Chain, and never again anywhere else: there is no Solana $PYRE, the pump.fun venue never mints one, and any "PYRE" on another chain is not ours — say so if asked.

1. Fund the treasury (≥ 0.01 ETH above the floor: the launch fee is 0.0005 ETH plus gas).
2. One command from the production env: `railway ssh --service runner -- node apps/runner/scripts/launch-pyre.mjs` (it prints the token/curve and the three env changes). The manual equivalent:

   ```
   node -e "import('@pyre/chain').then(async c => {
     const t = c.treasury();
     const r = await c.launchPonsToken(t.account, {
       name: 'Pyre', symbol: 'PYRE',
       logo: 'https://pyre.fun/icon-512.png',
       description: 'the coin that funds every app on pyre.fun. 25% of every coin\'s fees buys it and burns it.',
       socials: { website: 'https://pyre.fun', twitter: '<x profile url>' },
       creatorFeeRecipient: t.address,
     });
     console.log(r);
   })"
   ```

   The result contains `hash`, `token` and `curve`. If it throws `LaunchGatedError`, PONS's public gate is closed for that sender; retry later or ask PONS to whitelist the treasury.
3. Set `PYRE_TOKEN=<token>` on `api` and `runner`, `VITE_PYRE_TOKEN=<token>` on `web`, redeploy all three.
4. From the next passes on: `feeSweep` claims $PYRE creator fees to the treasury, `buyback` swaps the `PYRE_TOKEN` ledger balance (25% of every Robinhood coin's creator fees) into $PYRE and burns it whenever it clears $5, staking (`POST /v1/pyre/stake`) and platform governance open, and `/pyre` leaves its pre-launch state.

## Enabling the pump.fun venue

The Solana venue ships dark: production has no `SOLANA_RPC_URL`, so `/v1/venues` lists only `pons_v2`, the launch picker shows one card and every existing Robinhood coin behaves exactly as before. Turn it on in this order; never skip the staging step.

1. **Staging on devnet first.** On the Railway `staging` environment set `SOLANA_RPC_URL=https://api.devnet.solana.com` (or a keyed devnet URL), `SOLANA_CLUSTER=devnet`, leave `PUMP_LAUNCH_ENABLED` unset, on `api` and `runner`, and redeploy. pump.fun's programs are deployed on devnet with `createV2Enabled` on; the devnet curve starts at 1 SOL of virtual reserves, so a coin graduates after ≈ 2.83 SOL and the whole curve → PumpSwap path is cheap to exercise.
2. **Fund the devnet treasury Solana wallet.** Print the address (Treasury above). Devnet SOL comes from a human: `solana airdrop 2 <address> --url devnet` from a CLI, or `https://faucet.solana.com` (2 requests per 8 h, GitHub-linked, forbids bots). Airdrop enough for a stake refund plus launches: 3–5 SOL.
3. **Run the integration script** against the same RPC: `SOLANA_DEVNET_KEY=<base58 secret> SOLANA_RPC_URL=… SOLANA_CLUSTER=devnet node packages/chain/scripts/pump-devnet.mjs` walks launch → buy → claim creator fees → burn → memo attestation with a funded devnet key and prints every signature. Check them on `https://solscan.io/tx/<sig>?cluster=devnet`: the burn lowers `getTokenSupply`, the memo reads `pyre:burn:v1:<hash>`.
4. **Smoke the product on staging.** Sign in, deposit devnet SOL to the custodial Solana address on `/me`, `/launch` → pick "Solana · pump.fun" → approve the spec → stake 1 SOL from the balance. Watch the `launch` worker pre-fund the app wallet and flip the app `LIVE`, buy the coin from `/me` (custodial), confirm `feeSweep` records a `FeeEvent` in lamports with a SOL price, and that `buyback` opens a `CoinBurn` once `COINBURN:<appId>` clears $5 (buy enough of the coin to get there — the creator fee is 30 bps). Confirm `reconcile` `BURNS` stays clean and the coin page shows the "coin burned" panel with the memo signature.
5. **Production.** Fund the mainnet treasury Solana wallet (the same address as on devnet — one seed, one key; only the cluster differs), set `SOLANA_RPC_URL` to a keyed mainnet provider and `SOLANA_CLUSTER=mainnet-beta` on `api` and `runner`, redeploy both. `/v1/venues` now returns both venues and the web offers the second card. Nothing about Robinhood Chain changes.
6. **Turning it off.** `PUMP_LAUNCH_ENABLED=false` on `api` and `runner` removes the venue from `/v1/venues` and refuses new Solana launches (`AWAITING_STAKE` Solana apps fail their stake with a clear error) while existing Solana coins keep sweeping, trading and burning. Unsetting `SOLANA_RPC_URL` disables the adapter entirely: Solana apps are skipped by every chain worker and their pages show stale numbers until it is back. `pauseFeeSweep` and `pauseBuyback` cover both chains.

pump.fun facts that matter operationally: it charges nothing to create a coin; the creator fee is 30 bps on the curve and a market-cap-tiered 0.30%–0.95% (declining to 0.05%) on the canonical PumpSwap pool, set by pump.fun's fee program and changeable by pump.fun; its terms allow bot access and make no warranty on creator fees, which can be re-routed under its community-takeover (CTO) process. The launch worker checks `Global.createV2Enabled` before every launch and parks the app in `LAUNCH_GATED` if pump.fun has switched creation off.

## Rotating keys

- `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `GITHUB_TOKEN`, `BLOCKSCOUT_API_KEY`, `X_*`: update the Railway variable, redeploy the affected service. In-flight build jobs finish on the old sandbox; job tokens are unaffected (they are platform-issued, not the vendor key).
- `SESSION_SECRET`: rotating logs every user out of the platform and every app user out of every app (JWTs and host cookies fail verification). Do it during low traffic.
- `INTERNAL_SECRET`, `GITHUB_WEBHOOK_SECRET`: rotate both sides (Railway variable and the consumer — Prometheus scraper / GitHub webhook config) in the same change.
- `GOOGLE_CLIENT_ID`: create the new OAuth client with the same authorized JavaScript origins, set it on `api` and as `VITE_GOOGLE_CLIENT_ID` on `web`, redeploy both.
- `PLATFORM_MASTER_SEED_HEX`: **cannot be rotated in place** — every custodial user balance on both chains, every app wallet, every PONS `creatorFeeRecipient` and every pump.fun `creator` is derived from it. If it leaks: set `pauseFeeSweep`, `pauseBuyback` and `pause_builds`, disable withdrawals by taking the API down if necessary, sweep every user and app wallet and both treasuries (ETH and SOL) to fresh treasuries derived from a new seed, then update `User.wallet` / `User.solWallet` / `App.walletAddress` rows and the seed together. Creator-fee claims for already-launched coins remain bound to the old app keys (PONS records the recipient at launch; pump.fun's creator vault is keyed by the creator pubkey and its collect instructions always pay that creator), so treat a leak as a full incident.

## Kill switches

`POST /v1/admin/apps/:id/kill { reason }` as an admin. Effects: `App.status = KILLED`, `killedReason` set, the app origin serves a 410 page, queued BuildJobs are cancelled and removed from BullMQ, running jobs are cancelled and their JobToken revoked (the runner aborts the sandbox), growth stops, the coin page shows the killed state. Fees already accrued stay in the ledger; `feeSweep` and `buyback` only visit `LIVE`/`DORMANT` apps, so new creator fees keep accruing on the curve or hook unclaimed. Reverse with `POST /v1/admin/apps/:id/unkill` (→ `LIVE`, or `DRAFT` if it never launched).

Platform-wide pauses are `PlatformSetting` rows set with `POST /v1/admin/settings { "key", "value" }`; a value of `true` pauses, anything else resumes:

- `pause_builds` — the scheduler creates no new BuildJobs and the build worker delays already-queued jobs by 15 minutes.
- `pauseFeeSweep` — no sweeps, claims, splits or stake refunds; the `credits` worker honours it too, so no card top-ups.
- `pauseBuyback` — no $PYRE swaps, burns or attestations and no Solana coin burns; the `PYRE_TOKEN` and `COINBURN:<appId>` ledger balances keep accumulating.

Only keys a worker reads have any effect.

Global compute: if `DailyComputeSpend` for today approaches `GLOBAL_DAILY_COMPUTE_CEILING_USD` ($2 000) the runner refuses new jobs and the Anthropic proxy answers 429; raise the constant only with a deploy.

## Reconcile

The `reconcile` worker runs seven checks every 5 minutes and writes one `ReconcileRun` row per check (visible on `/ops`): `JOBS`, `SANDBOXES`, `JOBTOKENS` (repair: settle dead builds, kill orphaned sandboxes, revoke spent tokens), `PAYOUTS` (repair: a treasury payout the API broadcast but could not confirm — fee claim, unstake, staker rewards, bounty — is settled from its receipt: ledger/status finalised on success, funds released on revert; `PAYOUT_DROPPED` means an hour with no receipt), `LEDGER` (report: budget vs ledger, fee-split sums), `FEES` (repair: escrow `Claimed` logs with no `FeeEvent` are replayed; app wallets holding unswept ETH are reported), `BURNS` (report: `PyreBurn.burnedUnits` vs the on-chain $PYRE supply reduction, and per Solana coin `CoinBurn.burnedUnits` vs that mint's `getTokenSupply` reduction; `PYRE_BURN_STUCK` is a $PYRE burn — and the `CoinBurn` equivalent a coin burn — parked in SWAPPING/SWAPPED for over 30 minutes — check the row's `error` and the swap tx before touching it, the ledger debit is already written). `drifted > 0` on `LEDGER`, `BURNS` or `PAYOUTS` needs a human; on `FEES` it usually means the runner was down while claims happened and has already been repaired.

There is no ad-hoc trigger; a pass runs on the next tick (≤ 5 min).

## Model-credit funding (Zentro card)

Mechanics in `docs/economics.md` → Model-credit funding. Operationally:

- **Prerequisites.** The founder's Zentro card is Anthropic's billing method with auto-reload on; `ZENTRO_STATE` is set on `runner`; the treasury holds ETH above the 0.01 ETH floor plus the top-up.
- **Capturing `ZENTRO_STATE`.** Sign in at `https://zentro.finance/dash` in a normal browser, then export `{ "cookies": [{ "name": "connect.sid", "value": …, "domain": "zentro.finance", "path": "/", "httpOnly": true }], "localStorage": { "cardhub_private_key": …, "cardhub_public_key": …, "cardhub_server_public_key": … } }` (cookie from DevTools → Application → Cookies; the three keys from Local Storage). Keep it in `.secrets/zentro-state.json` locally (git-ignored) and set the one-line JSON as the `ZENTRO_STATE` variable on `runner`. Never paste it into logs, issues or chat.
- **Verifying without moving money.** `ZENTRO_STATE=$(cat .secrets/zentro-state.json) node apps/runner/scripts/probe-zentro.mjs 15 --quote` (needs `npm run build -w @pyre/runner` and `npx playwright install chromium` locally, or `railway ssh --service runner`) mints one deposit address, prints it masked, and fetches — never sends — the Relay quote the runner would use.
- **`ZENTRO_SESSION_EXPIRED` on `/ops`.** The session stopped authenticating. Re-capture `ZENTRO_STATE`, redeploy `runner`; the next `credits` pass after the 6-hour back-off (or a restart, which does not reset the back-off — clear it with `POST /v1/admin/settings { "key": "credits_funding", "value": { "mode": "zentro", "sessionExpiredAt": null } }`) resumes. Credits keep accruing meanwhile.
- **`credits_accrue_only` on `/ops`.** `ZENTRO_STATE` is unset on `runner`; intended until the card is wired up.
- **`stuck_funding` on `/ops`.** A `CreditFunding` older than 30 minutes is still `ADDRESS_MINTED` (unsent: the treasury could not afford the quote, or the pass kept failing — check runner logs; the row fails itself after 30 minutes unsent and a fresh address is minted) or `SENT` (Relay has the ETH but no fill yet: check `https://api.relay.link/intents/status?requestId=<relayRequestId>`; every pass keeps polling and settles it, `refund` fails the row and the ETH is back in the treasury).
- **Reconciling by hand.** `CreditFunding.usdMicros` is the obligation, `usdcUnits` what Relay delivered (6-decimal USDC on Ethereum), `ethWei` what the treasury paid including Relay's fee, `fillTx` the Ethereum transaction to the card's address. The `CREDITS:<appId>` debit is written only with `CONFIRMED`, so a `FAILED` row never leaves a coin's balance short.

## DMCA flow

1. Notice arrives (`dmca@pyre.fun`, the address published in the content policy, or `POST /v1/reports` with `kind: "DMCA"`). Confirm it names the work, the infringing URL (`https://<slug>.pyre.fun` or the `pyre-<slug>` repo), and includes a good-faith statement and signature.
2. Within one business day: `POST /v1/admin/apps/:id/kill` with reason `DMCA <report id>` and mark the report actioned (`POST /v1/admin/reports/:id { status: "ACTIONED" }`). Kill also stops builds so the agent cannot re-deploy the material.
3. Notify the launcher with the notice and counter-notice instructions. No email is stored: use the in-app notification and, if set, the X handle on the account (`User.xHandle`).
4. Counter-notice: forward to the claimant; if no court action within 10–14 business days, `unkill` and let the launcher (or a prompt-queue task) remove the material before the next deploy.
5. Repeat infringers: ban the user (`User.bannedAt`), which blocks sign-in and new launches.

## Restoring a dormant app

An app is `DORMANT` when `budgetMicros` fell under $10. Ways back to `LIVE`:

- Organic: any swept creator fee that lifts the budget to ≥ $10 revives it; `feeSweep` flips status and emits `REVIVED`.
- Holder top-up: `POST /v1/apps/:slug/topup { eth }` sends ETH from the caller's custodial wallet to `App.walletAddress`; 100% of it becomes budget (`FeeEvent.source = REVIVE_BUY`) and the status flips immediately.
- Ops credit: insert a `FeeEvent` with `source = MANUAL` and matching `LedgerEntry` on `BUILD:<appId>`, then set `App.budgetMicros`; the next scheduler tick revives the app. Use for incidents where a platform bug burned budget.

After revival the growth worker posts a revive announcement if `growthEnabled` and budget ≥ $2. If the app was also unhealthy, the monitor's next check enqueues `SELF_HEAL` with the last error.

## Launch gated

`LAUNCH_GATED` means the venue's `canLaunch(appWallet)` returned false. On PONS: `factory.canLaunch` says PONS closed public launches or removed the sender from its whitelist — nothing to do unless it persists for hours, then ask PONS. On pump.fun: `Global.createV2Enabled` is off, an admin switch pump.fun flips during incidents — wait; there is nobody to ask. Either way the app keeps its stake, the launcher gets a notification, and the `launch` worker retries every gated app every 10 minutes. If the gate is permanent, refund the stake by hand from that chain's treasury wallet and set the app `FAILED`.
