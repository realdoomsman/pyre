# Runbook

Operational procedures for Pyre. Commands assume the repo root unless noted.

## Environment

Copy `.env.example` and fill every value. Groups, in the order the file lists them:

- **Core**: `DATABASE_URL`, `REDIS_URL`, `WEB_ORIGIN`, `API_ORIGIN`, `APP_DOMAIN` (wildcard `*.APP_DOMAIN` → API; leave empty to serve apps at `API_ORIGIN/a/<slug>`), `INTERNAL_SECRET` (bearer for `/metrics`), `SESSION_SECRET` (signs platform session JWTs and per-app host cookies), `LOG_LEVEL`, `PORT`.
- **Auth**: `GOOGLE_CLIENT_ID` (Google Identity Services; the same client id is exposed to the web app and to hosted apps as `VITE_GOOGLE_CLIENT_ID` / `window.__PYRE__.googleClientId`). Wallet sign-in needs nothing extra — it is an EIP-191 challenge verified server-side.
- **Robinhood Chain**: `RPC_URL` (the public `https://rpc.mainnet.chain.robinhood.com` is rate-limited and has no websocket; use an Alchemy Robinhood Chain app URL in production), `RPC_WSS_URL` (optional, Alchemy), `CHAIN_ID=4663`, `PLATFORM_MASTER_SEED_HEX` (16–64 bytes hex; users derive at `m/44'/60'/0'/0/<walletIndex>`, treasury = index 0; apps derive at `m/44'/60'/1'/0/<keypairIndex>`), `TREASURY_WALLET` (informational), `PYRE_TOKEN` (empty until launched), `LAUNCH_STAKE_WEI` (override; default 0.05 ETH), `USDG_ADDRESS`, `PONS_FACTORY` / `PONS_LAUNCH_AND_BUY` / `PONS_FEE_ESCROW` / `PONS_MEME_HOOK`, `UNIV4_POOL_MANAGER` / `UNIV4_UNIVERSAL_ROUTER` / `UNIV4_QUOTER` / `UNIV4_STATE_VIEW`, `BLOCKSCOUT_URL`, `BLOCKSCOUT_API_KEY` (optional), `ZENTRO_STATE` (optional, runner only; see Model-credit funding), `GITHUB_WEBHOOK_SECRET`.
- **Solana / pump.fun** (required for launches: new coins launch on pump.fun only, and until `SOLANA_RPC_URL` is set the venue does not exist and Pyre accepts no launches): `SOLANA_RPC_URL` (HTTPS JSON-RPC; the public `api.mainnet-beta.solana.com` often cannot send transactions — use a Helius or QuickNode URL in production, `https://api.devnet.solana.com` or a keyed devnet URL on staging), `SOLANA_CLUSTER` (`mainnet-beta` | `devnet`; picks pump.fun's devnet deployment, explorer `?cluster=devnet` links and the devnet curve parameters), `SOLANA_WSS_URL` (optional websocket for the same provider), `PUMP_LAUNCH_ENABLED` (default `true` when the RPC is set; `false` marks `pump_fun` disabled in `/v1/venues` and closes launches without unsetting the RPC, so existing Solana coins keep sweeping, trading and burning), `PYRE_SOL_MINT` (base58 mint of the Solana PYRE coin, *PYRE refund program*; empty until launched, nothing accrues from that coin while unset). Solana keys derive from the same `PLATFORM_MASTER_SEED_HEX`: users at SLIP-0010 ed25519 `m/44'/501'/<walletIndex>'/0'`, treasury = index 0; apps at `m/44'/501'/<1000000 + keypairIndex>'/0'`. Set the same values on `api` and `runner`; never on `web` (the browser never talks to a Solana RPC).
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

Keep the treasury in ETH on Robinhood Chain. It serves the 7 legacy Robinhood Chain coins and every launcher (PONS v2 launches are closed, so it no longer pre-funds launches). It pays for: gas top-ups for fee sweeps, the $PYRE buyback swap (the `PYRE_TOKEN` share is ledgered in USD; the buy is paid in ETH at the current price), burn and attestation gas, ETH stake refunds for legacy coins, **launcher payouts for coins on either chain** (the `LAUNCHER:` ledger is USD micros and is always paid in ETH on Robinhood Chain), and bounty payouts. Credit top-ups are paid from the treasury Solana wallet, not from here. The legacy coins' 25% share also lands here as ETH, but while it is credited to the `REFUND` pool it is paid out as SOL from the treasury Solana wallet, not spent from here (*PYRE refund program*). Every spending path refuses to take the balance below `TREASURY_FLOOR_WEI` (0.01 ETH) and retries next cycle, so an empty treasury degrades to "nothing moves" rather than to a broken state. ~0.05 ETH covers dozens of sweeps at current gas; alert under 0.02 ETH.

Keep the treasury Solana wallet in SOL. It pays for: pre-funding each Solana app wallet with `predictLaunchCost` (≈ 0.005 SOL of rent; pump.fun charges nothing to create) plus a gas float, the coin-burn buys (`COINBURN:<appId>` is ledgered in USD; each buy is paid in SOL at the current price), burn + memo transaction fees (5 000 lamports a signature plus a priority fee), SOL stake refunds (1 SOL each — the largest single outflow, so hold at least one stake's worth per app awaiting its first build), PYRE refund payouts (*PYRE refund program*; the legacy coins' share of that pool arrives as ETH in the Robinhood treasury, so it must be topped up here by hand), and model-credit card top-ups (SOL → USDC on Ethereum via Relay, up to $250 each; *Model-credit funding* below). It never pays launchers. Refunds, burns, launches and top-ups never take it below `TREASURY_SOL_FLOOR_LAMPORTS` (0.1 SOL, `apps/runner/src/workers/chain/wallet.ts`). A $5 buyback costs about 0.043 SOL plus ≈ 0.003 SOL of one-off account rent per coin. ~0.5 SOL covers dozens of launches and burns; alert under 0.1 SOL plus outstanding stakes, outstanding refund credit and accrued `CREDITS:` balances.

Bridge ETH from Arbitrum One or Ethereum with the Robinhood Chain bridge, or send from any exchange that supports the chain directly, to the address above. Confirm on Blockscout: `https://robinhoodchain.blockscout.com/address/0xdd9F2043c2df2Cd675ff4eF75373E82bB68389b6`. Send SOL from any exchange or wallet to the treasury Solana wallet on Solana mainnet (devnet SOL for staging comes from a faucet, see *Enabling the pump.fun venue*) and confirm on Solscan: `https://solscan.io/account/<address>` (`?cluster=devnet` on staging).

Claimed creator fees land in the treasury in the coin's native asset: ETH on Robinhood Chain, SOL in the treasury Solana wallet. The launcher and staker shares are paid out of the Robinhood treasury in ETH on claim, the build and credits shares are spent from it, the `PYRE_TOKEN` share is swapped and burned from it, each Solana coin's burn share is swapped and burned from the treasury Solana wallet, and PYRE refunds are paid from the treasury Solana wallet. Nothing is bridged between the two.

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

$PYRE on Robinhood Chain is a PONS v2 launch whose creator is the treasury, launched with a 2.5% creator tax (`creatorTaxBps = 250` on-chain; app coins launch with 0), so its creator fees and tax flow to the treasury and `feeSweep` claims them as platform fees (`sweepPlatformFees`). It was launched once and is never launched again on Robinhood Chain. $PYRE is moving to Solana as one new pump.fun coin with a 2 SOL founder dev buy at creation, locked for 12 months on Streamflow, and 100% of its creator fees going to the treasury Solana wallet (*PYRE refund program* below); the pump.fun app venue never mints it. Until `PYRE_SOL_MINT` is set and published on pyre.fun, any "PYRE" on Solana or another chain is not ours — say so if asked. The procedure below is the historical Robinhood launch, kept for reference.

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
4. From the next passes on: `feeSweep` claims $PYRE creator fees to the treasury, `buyback` swaps the `PYRE_TOKEN` ledger balance (25% of every Robinhood coin's creator fees; since the move, only once every refund snapshot holder is settled — until then that share goes to `REFUND`) into $PYRE and burns it whenever it clears $5, staking (`POST /v1/pyre/stake`) and platform governance open, and `/pyre` leaves its pre-launch state.

## Enabling the pump.fun venue

New coins launch on pump.fun only and PONS v2 launches are closed in code, so until the Solana venue is on Pyre accepts no launches at all: without `SOLANA_RPC_URL`, `/v1/venues` reports both `pump_fun` and `pons_v2` as `enabled: false`, while every legacy Robinhood Chain coin keeps sweeping, building, trading and paying its launcher.

**Decision (owner, 2026-10-04): production goes to Solana mainnet directly.** Steps 1–4 below — devnet staging, the devnet integration run and the staging product smoke — are skipped for production by that decision; only step 5 applies. Whether it has been deployed, and what was observed afterwards, is recorded in `docs/go-live.md`, not here. Steps 1–4 remain the procedure for any staging environment.

1. **Staging on devnet.** On the Railway `staging` environment set `SOLANA_RPC_URL=https://api.devnet.solana.com` (or a keyed devnet URL), `SOLANA_CLUSTER=devnet`, leave `PUMP_LAUNCH_ENABLED` unset, on `api` and `runner`, and redeploy. pump.fun's programs are deployed on devnet with `createV2Enabled` on; the devnet curve starts at 1 SOL of virtual reserves, so a coin graduates after ≈ 2.83 SOL and the whole curve → PumpSwap path is cheap to exercise.
2. **Fund the devnet treasury Solana wallet.** Print the address (Treasury above). Devnet SOL comes from a human: `solana airdrop 2 <address> --url devnet` from a CLI, or `https://faucet.solana.com` (2 requests per 8 h, GitHub-linked, forbids bots). Airdrop enough for a stake refund plus launches: 3–5 SOL.
3. **Run the integration script** against the same RPC: `SOLANA_DEVNET_KEY=<base58 secret> SOLANA_RPC_URL=… SOLANA_CLUSTER=devnet node packages/chain/scripts/pump-devnet.mjs` walks launch → buy → claim creator fees → burn → memo attestation with a funded devnet key and prints every signature. Check them on `https://solscan.io/tx/<sig>?cluster=devnet`: the burn lowers `getTokenSupply`, the memo reads `pyre:burn:v1:<hash>`.
4. **Smoke the product on staging.** Sign in, deposit devnet SOL to the custodial Solana address on `/me`, `/launch` (pump.fun is the only venue) → approve the spec → stake 1 SOL from the balance. Watch the `launch` worker pre-fund the app wallet and flip the app `LIVE`, buy the coin from `/me` (custodial), confirm `feeSweep` records a `FeeEvent` in lamports with a SOL price, and that `buyback` opens a `CoinBurn` once `COINBURN:<appId>` clears $5 (buy enough of the coin to get there — the creator fee is 30 bps). Confirm `reconcile` `BURNS` stays clean and the coin page shows the "coin burned" panel with the memo signature.
5. **Production.** Fund the mainnet treasury Solana wallet (the same address as on devnet — one seed, one key; only the cluster differs), set `SOLANA_RPC_URL` to a keyed mainnet provider and `SOLANA_CLUSTER=mainnet-beta` on `api` and `runner`, redeploy both. `/v1/venues` now reports `pump_fun` enabled and `/launch` opens. Nothing about the legacy Robinhood Chain coins changes. With no devnet run behind it, treat the first mainnet launch as the integration run: walk the step 4 checks against it with a real 1 SOL stake and record the signatures in `docs/go-live.md`.
6. **Turning it off.** `PUMP_LAUNCH_ENABLED=false` on `api` and `runner` marks `pump_fun` disabled in `/v1/venues` and refuses new Solana launches — with PONS v2 closed, that means no launches at all (`AWAITING_STAKE` Solana apps fail their stake with a clear error) — while existing Solana coins keep sweeping, trading and burning. Unsetting `SOLANA_RPC_URL` disables the adapter entirely: Solana apps are skipped by every chain worker, refund payouts stop, and their pages show stale numbers until it is back. `pauseFeeSweep` and `pauseBuyback` cover both chains.

pump.fun facts that matter operationally: it charges nothing to create a coin; the creator fee is 30 bps on the curve and a market-cap-tiered 0.30%–0.95% (declining to 0.05%) on the canonical PumpSwap pool, set by pump.fun's fee program and changeable by pump.fun; its terms allow bot access and make no warranty on creator fees, which can be re-routed under its community-takeover (CTO) process. The launch worker checks `Global.createV2Enabled` before every launch and parks the app in `LAUNCH_GATED` if pump.fun has switched creation off.

## PYRE refund program

Holders of the Robinhood Chain PYRE at block 79819827 (`REFUND_SNAPSHOT` in `packages/shared/src/refund.ts`) are refunded the ETH they put in (`owedWei = max(0, min(ethIn − ethOut, ethIn × min(balance, bought) / bought))`, 0 when nothing was bought: the ETH put in minus the ETH taken out, capped at what they paid for the PYRE they still held at the snapshot), never more, and only while they still hold the PYRE they held at the snapshot: selling or moving any of it after the snapshot (including to another wallet of their own) shrinks the refund for good, proportionally; buying more never raises it. A holder's eligible amount is `eligibleWei = owedWei × min(minBalanceUnits, balanceUnits) / balanceUnits` (`refundEligibleWei`), where `minBalanceUnits` is the lowest PYRE balance the address has had since the snapshot. The money has two sources, both credited to the `REFUND` ledger account in USD at claim time only while any holder still has eligible wei left to settle (`eligibleWei − settledWei > 0`):

- **The Solana PYRE coin**: 25% (`REFUND_FEE_BPS`) of its creator fees that reach the treasury Solana wallet (25% of the lamports the treasury actually received in that transaction); the other 75% stays in the treasury. The chosen launch path is the founder launching it from his own wallet and routing 100% of its creator fees to the treasury with pump.fun fee sharing (step 4); the fallback is the treasury launching it and so being its creator.
- **The legacy Robinhood Chain coins**: at each fee claim of the 7 legacy coins, `feeSweep` (`recordCreatorFee`) decides inside the `FeeEvent`'s DB transaction, with the same still-owed test as the Solana credit, whether the 25% leg goes to `REFUND` (`refType "FeeEvent"`, `refId` = the `FeeEvent` id, memo "legacy Robinhood Chain coin fee share") or to `PYRE_TOKEN`; `FeeEvent.pyreMicros` records the leg either way. It does not depend on `PYRE_SOL_MINT`. With `RefundHolder` empty (snapshot not loaded) nobody counts as owed, so the leg goes to `PYRE_TOKEN` and is burned — load the snapshot (step 1) before the runner carrying this routing sweeps. Once every holder is settled it goes back to `PYRE_TOKEN` and the $PYRE buy-and-burn; PYRE already accrued on `PYRE_TOKEN` keeps being burned meanwhile.

**Funding the payouts (legacy share).** A legacy-share credit is USD in the pool, but the ETH behind it is claimed into the Robinhood treasury; payouts are SOL from the treasury Solana wallet. Nothing bridges automatically. The operator must keep the treasury Solana wallet funded for the outstanding credit — move value from the Robinhood treasury (or elsewhere) to it by hand — or payouts stop at the SOL floor (step 2) while credit keeps accruing.

Every 10 minutes the `refunds` worker first brings every holder's PYRE balance up to date from the token's `Transfer` logs (below), then allocates the `REFUND` balance pro-rata to each holder's remaining eligible wei (`eligibleWei − settledWei`, valued at the current ETH price, capped at what remains), then pays linked holders their accrued credit in SOL at the current SOL price. Credit already allocated stays payable after a sell; it is never clawed back. Holders link a Solana wallet at `/refund`; unlinked holders keep accruing credit.

1. **Load the snapshot** (once, before the first `refunds` pass would move the holding cursor, and before the runner that routes the legacy coins' share sweeps — with no holders loaded that share goes to `PYRE_TOKEN`; re-running is safe). The runner image carries `data/pyre-refund-snapshot.json`; another file can be given with `--file`:

   ```
   railway ssh --service runner -- node apps/runner/scripts/load-refund-snapshot.mjs --dry-run
   railway ssh --service runner -- node apps/runner/scripts/load-refund-snapshot.mjs
   ```

   It refuses a file whose sha256 is not the pinned one (`SNAPSHOT_SHA256` in the loader: the reviewed `data/pyre-refund-snapshot.json`, 785 holders, 229 owed, 11.846939549841023398 ETH) unless `--allow-unpinned` is passed, a file whose `chainId`/`token`/`block`/`blockHash` differ from `REFUND_SNAPSHOT`, any non-checksummed or duplicate address, a zero balance, a missing `boughtUnits`, or an `owedWei` that is not `max(0, min(ethInWei − ethOutWei, ethInWei × min(balanceUnits, boughtUnits) / boughtUnits))` (integer floor; 0 when `boughtUnits = 0`). With `--dry-run` and no `DATABASE_URL` it validates the file only. Missing rows are created with the snapshot fields only, `currentBalanceUnits` and `minBalanceUnits` both set to the snapshot `balanceUnits`. Existing rows are checked against the file and never overwritten; any disagreement (or a row in the database that is not in the file) aborts with nothing written. It prints holder counts and total owed.

   The `refunds` worker never moves `refund:holdCursor` while `RefundHolder` is empty, so deploying the runner before loading is harmless. The loader still refuses to insert rows once the cursor is past the snapshot block (new rows would start at the snapshot balance and miss every transfer already applied). To recover, delete the cursor and rerun the loader: `DELETE FROM "PlatformSetting" WHERE key = 'refund:holdCursor';`. That is safe at any time: a pass that starts from the snapshot block (cursor absent) first resets every holder's `currentBalanceUnits`/`minBalanceUnits` to the snapshot `balanceUnits` and then replays every transfer, so it recomputes the same balances instead of applying transfers twice. Allocation waits until the replay has caught up.
2. **Fund the treasury Solana wallet** (address: *Treasury* above). It pays for every refund payout, and on the fallback script path for the launch too (≈ 0.005 SOL of rent plus fees; the script wants twice `predictLaunchCost`). Payouts never take it below `TREASURY_SOL_FLOOR_LAMPORTS` (0.1 SOL, `apps/runner/src/workers/chain/wallet.ts`), which is kept for claims and fees; below that, payouts stop with a log line and credit keeps accruing. Keep enough SOL above the floor to cover the outstanding credit (`SUM("creditMicros")` below, at the SOL price) — including credit funded by the legacy coins' share, whose ETH sits in the Robinhood treasury.
3. **Host the coin metadata** (fallback script path only). pump.fun reads name, symbol, description and image from a JSON at the URI recorded at creation (app launches use the API's `/v1/apps/:slug/metadata.json`; PYRE is not an app). Print the body with `node apps/runner/scripts/launch-pyre-sol.mjs --print-metadata` and serve it at a permanent public https URL (for example `apps/web/public/pyre-sol-metadata.json` → `https://pyre.fun/pyre-sol-metadata.json`). The URI cannot be changed after launch.
4. **Launch the Solana PYRE coin.** The chosen path is the founder launch (second paragraph below). The fallback is the script, which requires `SOLANA_RPC_URL` on mainnet and `PYRE_SOL_MINT` unset:

   ```
   railway ssh --service runner -- node apps/runner/scripts/launch-pyre-sol.mjs --metadata-url https://pyre.fun/pyre-sol-metadata.json --confirm
   ```

   It checks the URL serves name `Pyre` / symbol `PYRE`, that pump.fun accepts launches and that the treasury holds twice the predicted cost, then sends `create_v2` with no dev buy and prints the mint, the pump.fun page and the env to set.

   **Chosen path: the founder launches from his own wallet** on pump.fun with a 2 SOL dev buy in the creation transaction, then locks the dev-buy tokens for 12 months on Streamflow and sends the lock link for pyre.fun (step 3 does not apply; the metadata is whatever he enters there). Right after the create, on the coin's pump.fun page he opens creator fee sharing, sets the treasury Solana wallet **`CZeNrWsfVqBciYLWYoLGc2wcMqozsAeVB14HVMwWqjah`** (*Treasury* above) as the **only** shareholder at **100%** (10 000 bps), removes himself, and confirms/finalizes. On chain that is `create_fee_sharing_config` (the coin's creator becomes the sharing-config PDA `["sharing-config", mint]` of the pump fees program, with the founder as the initial 100% shareholder) followed by `update_fee_shares_v2` (the final list; it can be sent only once — the admin is revoked after it, so the split can never change again). Do it before trading picks up: fees accrued before `create_fee_sharing_config` stay in the founder's own creator vault, and `update_fee_shares_v2` first pays whatever the sharing config already holds to the *current* list (the founder); neither reaches the treasury or the `REFUND` pool. Check on Solscan that the sharing-config account lists only the treasury, then continue with step 5. Until it is finalized the runner reports the route as not routed (below).
5. **Set `PYRE_SOL_MINT=<mint>`** on `api` and `runner` and redeploy both. From the next `feeSweep` pass (5 min) the treasury collects the coin's creator fees and its `REFUND` share accrues; nothing accrues from the Solana coin while it is unset (the legacy coins' share does not depend on it). Payouts start once a linked holder's credit reaches $1 (`REFUND_MIN_PAYOUT_MICROS`), at most 50 per pass.

**Fee route.** Every `feeSweep` pass reads the coin's current creator — `Pool.coinCreator` once it has graduated to PumpSwap, else `BondingCurve.creator` (fee sharing rewrites both) — and takes one of three routes (`claimPyreSolFees`, `packages/chain/src/pump/feesClaim.ts`):

- `creator` — the treasury is the creator: it collects the curve vault (`collect_creator_fee`) and the PumpSwap vault (`collect_coin_creator_fee`, unwrapped to SOL) to itself.
- `shared` — the creator is the coin's sharing-config PDA. The runner decodes the sharing config; if the treasury is a shareholder and pump's own `get_minimum_distributable_fee` view (simulated with the treasury as signer; for a graduated coin it includes sweeping the PumpSwap vault into the curve vault first) says there are fees it can distribute, the treasury sends `transfer_creator_fees_to_pump` (graduated coins only) + `distribute_creator_fees` and pays the transaction fee, so fees keep moving even when nobody else distributes. Every shareholder is paid in that transaction. Below the minimum, fees simply wait in the vault for a later pass. Crediting does not depend on who distributed (next paragraph).
- `foreign` — another wallet is the creator (the founder launched but never set up fee sharing): nothing to claim.

`foreign`, or `shared` without the treasury among the shareholders, means none of the fees reach the treasury: each pass logs `Solana PYRE creator fees do not reach the treasury` (warn) and the `REFUNDS` reconcile check reports `REFUND_FEES_NOT_ROUTED`, naming the creator or the shareholders. The route last seen is kept in `PlatformSetting` `refund:feeRoute` (`route`, `creator`, `shareholders`, `treasuryShareBps`, `checkedAt`); every change of it writes a `PLATFORM_FEE_ROUTE` audit row with the previous one.

**Distribution receipts (`shared` route).** Distribution is permissionless: pump.fun's site, a bot or any shareholder may run it before the runner does, and the treasury's share then arrives in a transaction the runner never sent. So on the `shared` route (and whenever the claim failed before the route was known) the `REFUND` credit comes only from a scan, never from the runner's own send: `pyreSolFeeReceipts` (`packages/chain/src/pump/feeReceipts.ts`) lists the treasury Solana wallet's finalized signatures newest → oldest down to the cursor (≤ 5 pages of 100 per pass), skips failed ones, fetches the rest (every live message version, v0 and v1) and keeps each successful transaction holding pump's `DistributeCreatorFeesEvent` for `PYRE_SOL_MINT`. The treasury's amount is its split of the event (`distributed × bps / 10 000`, the rounding remainder going to the first shareholder, as pump pays it), capped at the treasury's actual lamport change in that transaction (fee added back when it paid), so extra SOL sent alongside or a transaction where the treasury also spent can never over-credit. Each receipt with a non-zero amount credits 25% of `amount × SOL price now` under its signature (`refType "PlatformFee"`, `refId` = signature, the same rule as claims, so the runner's own distribution is credited exactly once) and writes a `PLATFORM_FEE_DISTRIBUTION` audit row; a distribution that paid the treasury 0 credits nothing. The treasury's own history is scanned rather than the sharing config because every buy and sell on the coin reads the sharing config (its history is mostly trades), while every lamport the treasury receives is in a transaction that lists it.

The cursor is `PlatformSetting` `refund:distributionCursor` (`mint`, `treasury`, `signature`: everything at or below it is credited; `catchUp`: `{ head, before }` while a backlog longer than one pass, or a failed credit, is being worked through — the next pass resumes below `before`, and once it reaches `signature`, `head` becomes the new `signature`). A failed credit stops the pass at that receipt and the cursor never moves past it; an RPC failure leaves the cursor untouched. A fresh receipt is credited within a pass or two of finalizing, so "SOL price now" is the price at distribution time to within minutes. Deleting the setting makes the next passes rescan the treasury's whole history; signatures already credited are skipped (credits are idempotent per signature).

**Pausing.** `PAYOUTS_FROZEN=1` on `runner` (the same incident freeze the API honours) or the `pause_refunds` setting (`POST /v1/admin/settings { "key": "pause_refunds", "value": true }`, or the toggle on `/ops`, which also raises an ops alert while it is set) stops refund payouts; both are re-checked before every single payout, so a pause set mid-run stops the run at the next holder. Allocation and fee accrual continue, so credit simply waits. `pauseFeeSweep` stops the fee claim and therefore new `REFUND` credits. Linking wallets is never frozen; it moves no money.

**Linking.** Both wallets sign the same EIP-4361 (Sign-In with Ethereum) message for `WEB_ORIGIN` on chain 4663, valid 5 minutes, whose statement names the Solana wallet and the snapshot block, so wallets show the requesting site and flag a phishing page. Nonces are kept per requester (hashed client IP), at most 4 live each, and the challenge/link rate limit is per IP and per IP + address, so nobody can evict or exhaust another holder's attempt. A first link pays immediately. Linking a DIFFERENT Solana wallet than the one already linked sets `RefundHolder.linkPendingUntil` to 48 hours later (`REFUND_RELINK_COOLDOWN_SECONDS`): payouts to the new wallet wait until then (credit keeps accruing), `/refund` shows "new payout wallet active from …", and the `REFUND_LINK` audit row carries `from`, `to` and `payoutsFrom`. A holder who did not make the change links their own wallet again (that restarts the 48 hours for it); an operator can also set `"solWallet"` back and `"linkPendingUntil"` to null by hand.

**Payout states.** A payout row (`RefundPayout`) is written `PENDING` together with taking the holder's credit, before any SOL moves. Confirmed → `CONFIRMED` and the holder's `paidMicros` grows. A transaction that failed → `FAILED` and the credit is restored. Broadcast but unconfirmed → `SENT` with its signature and `lastValidBlockHeight` (the Solana block height after which its blockhash can no longer land). The send never re-signs a second transfer unless the first is provably dead: the finalized block height is past its `lastValidBlockHeight` and the signature is unknown even with full history search; a `processed` or unreadable status ends the send as `SENT` instead. Each pass resolves `SENT` rows from `getSignatureStatuses` with history search: confirmed/finalized → `CONFIRMED` (or `FAILED` with credit restored if it errored); unknown → `FAILED` with credit restored ONLY once the finalized block height is past the row's `lastValidBlockHeight`. A `processed` status, a height not yet past, or a row with no recorded height stays `SENT`; reconcile reports one older than an hour as `REFUND_PAYOUT_STUCK_SENT` (look the `txSig` up on Solscan and resolve it like a stuck `PENDING` row). A send whose outcome is unknown and has no signature (RPC transport error) stays `PENDING`; reconcile reports it as `REFUND_PAYOUT_STUCK_PENDING` after an hour. Check the treasury Solana wallet's history on Solscan for a transfer to that `solWallet` of that `lamports`: if it landed, set the row `CONFIRMED` with its `txSig` and add `usdMicros` to the holder's `paidMicros`; if not, set it `FAILED` and add `usdMicros` back to `creditMicros` — both in one SQL transaction.

**Fee credits.** Every Solana PYRE `REFUND` credit writes a `RefundFeeCredit` row (primary key = the collect/distribution signature, with the treasury's `lamports` and the credited `usdMicros`) and the `LedgerEntry` in one transaction, so two overlapping passes can never credit one claim twice: the second insert fails on the key, its ledger entry rolls back with it, and it logs "already credited". On the `creator` route, a claim that was broadcast but could not be confirmed is kept in `PlatformSetting` `refund:pendingCreatorClaims` (at most 20) and resolved at the start of the next pass: landed → credited by the treasury's lamport delta in that transaction under its signature; failed on chain → dropped; still unknown → kept. A legacy coin's credit is written with its `FeeEvent` in the same transaction, so it is exactly as idempotent as the fee claim itself. `GET /v1/refund` is cached 30 s.

**Holding.** Each `refunds` pass applies the PYRE `Transfer` logs after the `PlatformSetting` cursor `refund:holdCursor` (last Robinhood block applied; absent means `REFUND_SNAPSHOT.block`) up to 600 blocks (≈ 60 s at ~0.1 s blocks) behind the tip, in (block, log index) order, ≤ 300k blocks per pass: a transfer out lowers `currentBalanceUnits` and pulls `minBalanceUnits` down with it, a transfer in only raises `currentBalanceUnits`. The 600-block margin covers a Nitro sequencer reorg (seconds) and replica lag behind a load-balanced RPC; on top of that every 10k-block chunk is fetched as ONE JSON-RPC batch of `eth_getBlockByNumber(end)` + `eth_getLogs`, so the node returning the logs must also have the end block, or the pass fails instead of advancing past logs it never saw. Nothing runs, and the cursor never moves, while `RefundHolder` is empty. A pass that starts from the snapshot block resets every holder to the snapshot balance first, so deleting the cursor replays from scratch idempotently. Balances and cursor are written in one transaction. Allocation runs only when this step succeeded and reached the reorg-safe head in the same pass; an RPC failure or a backlog (runner down for hours) logs `allocation skipped` and the pool simply waits, while payouts of credit already allocated continue. Nothing to do by hand: the next pass resumes from the cursor.

**Reading state.** `GET /v1/refund` is the public summary; `GET /v1/refund/holders/<address>` one holder. In SQL:

```
SELECT SUM("deltaMicros") FROM "LedgerEntry" WHERE account = 'REFUND';                    -- unallocated pool
SELECT "refType", SUM("deltaMicros") FROM "LedgerEntry" WHERE account = 'REFUND' AND "deltaMicros" > 0 GROUP BY "refType";  -- credits by source: PlatformFee = Solana PYRE, FeeEvent = legacy coins
SELECT COUNT(*), SUM("owedWei"), SUM("settledWei"), SUM("creditMicros"), SUM("paidMicros") FROM "RefundHolder";
SELECT COUNT(*) FROM "RefundHolder" WHERE "settledWei" < div("owedWei" * LEAST("minBalanceUnits", "balanceUnits"), "balanceUnits");  -- still eligible
SELECT COUNT(*) FROM "RefundHolder" WHERE "minBalanceUnits" = "balanceUnits";             -- still holding everything
SELECT value FROM "PlatformSetting" WHERE key = 'refund:holdCursor';                       -- last Robinhood block applied
SELECT value FROM "PlatformSetting" WHERE key = 'refund:feeRoute';                         -- creator / shared / foreign, as the last fee sweep saw it
SELECT value FROM "PlatformSetting" WHERE key = 'refund:distributionCursor';              -- how far the treasury's history is scanned for distributions
SELECT status, COUNT(*), SUM("usdMicros") FROM "RefundPayout" GROUP BY status;
```

Audit rows: `PLATFORM_FEE_CLAIM` per claim or distribution the runner sent (meta `chain: "solana"`, `route`, `creator`, `treasuryShareBps`, `refundMicros` — `null` on the `shared` route, where the receipt scan credits), `PLATFORM_FEE_DISTRIBUTION` per distribution credited to `REFUND` (meta `signature`, `lamports`, `eventLamports`, `balanceLamports`, `solPriceUsd`, `refundMicros`), `PLATFORM_FEE_ROUTE` per route change, `REFUND_ALLOCATION` per allocation run, `REFUND_PAYOUT` per payout outcome, `REFUND_LINK` per wallet link. The `REFUNDS` reconcile check asserts that the pool is never negative, that allocation debits equal holder credit + paid + in-flight payouts, that no holder is settled past what they are owed, and that no holder's `minBalanceUnits` exceeds its snapshot or current balance (`REFUND_HOLDING_DRIFT`), and reports `REFUND_FEES_NOT_ROUTED` while the coin's creator fees go to someone other than the treasury (fee route above). When every holder is settled up to their eligible amount (or has sold out) the fee share stops and the coin's whole creator fee stays in the treasury.

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

- **Prerequisites.** The founder's Zentro card is Anthropic's billing method with auto-reload on; `ZENTRO_STATE` is set on `runner`; `SOLANA_RPC_URL` points at mainnet (`SOLANA_CLUSTER=mainnet-beta`; otherwise balances only accrue, with a runner log line); the treasury Solana wallet holds SOL above the 0.1 SOL floor plus the top-up (≈ 0.125 SOL per $15 at $120/SOL, Relay's fee included).
- **Capturing `ZENTRO_STATE`.** Sign in at `https://zentro.finance/dash` in a normal browser, then export `{ "cookies": [{ "name": "connect.sid", "value": …, "domain": "zentro.finance", "path": "/", "httpOnly": true }], "localStorage": { "cardhub_private_key": …, "cardhub_public_key": …, "cardhub_server_public_key": … } }` (cookie from DevTools → Application → Cookies; the three keys from Local Storage). Keep it in `.secrets/zentro-state.json` locally (git-ignored) and set the one-line JSON as the `ZENTRO_STATE` variable on `runner`. Never paste it into logs, issues or chat.
- **Verifying without moving money.** `ZENTRO_STATE=$(cat .secrets/zentro-state.json) node apps/runner/scripts/probe-zentro.mjs 15 --quote --sender=<treasury Solana address>` (needs `npm run build -w @pyre/runner` and `npx playwright install chromium` locally, or `railway ssh --service runner`) mints one deposit address, prints it masked, and fetches — never sends — the Relay SOL → USDC quote the runner would use, with the lamports in and the deposit's instruction and lookup-table counts. Without `--sender` it quotes for a placeholder address.
- **`ZENTRO_SESSION_EXPIRED` on `/ops`.** The session stopped authenticating. Re-capture `ZENTRO_STATE`, redeploy `runner`; the next `credits` pass after the 6-hour back-off (or a restart, which does not reset the back-off — clear it with `POST /v1/admin/settings { "key": "credits_funding", "value": { "mode": "zentro", "sessionExpiredAt": null } }`) resumes. Credits keep accruing meanwhile.
- **`credits_accrue_only` on `/ops`.** `ZENTRO_STATE` is unset on `runner`; intended until the card is wired up.
- **`stuck_funding` on `/ops`.** A `CreditFunding` older than 30 minutes is still `ADDRESS_MINTED` (unsent: the treasury Solana wallet could not afford the quote above its floor, or the pass kept failing — check runner logs; the row fails itself after 30 minutes unsent and a fresh address is minted) or `SENT` (Relay has the deposit but no fill yet, or the deposit's confirmation could not be read: check `https://api.relay.link/intents/status?requestId=<relayRequestId>` and the `sendTx` signature on Solscan; every pass keeps polling and settles it, `refund` fails the row and the SOL is back in the treasury Solana wallet). A `SENT` row whose signature never landed stays `SENT` with Relay at `unknown`: fail it by hand once Solscan shows the signature as not found well after its blockhash expired.
- **Reconciling by hand.** `CreditFunding.usdMicros` is the obligation, `usdcUnits` what Relay delivered (6-decimal USDC on Ethereum), `nativeWei` what the treasury paid including Relay's fee in the unit of `originChain` (lamports for `solana`; wei for the `robinhood` rows paid in ETH before the 2026-10-04 cutover), `sendTx` the origin deposit (a Solana signature, or a Robinhood Chain hash on old rows), `fillTx` the Ethereum transaction to the card's address. The `CREDITS:<appId>` debit is written only with `CONFIRMED`, so a `FAILED` row never leaves a coin's balance short.

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

`LAUNCH_GATED` means pump.fun's `canLaunch(appWallet)` returned false: `Global.createV2Enabled` is off, an admin switch pump.fun flips during incidents — wait; there is nobody to ask. The app keeps its stake, the launcher gets a notification, and the `launch` worker retries every gated app every 10 minutes. If the gate is permanent, refund the stake by hand from the treasury Solana wallet and set the app `FAILED`. PONS v2 launches are closed: the `launch` worker adopts a `pons_v2` app still `LAUNCHING` or `LAUNCH_GATED` if its coin is already on chain, and otherwise fails it and refunds its stake ("PONS v2 launches are closed; new coins launch on pump.fun"); approving or staking a `pons_v2` app in `AWAITING_STAKE` is refused with 409 `venue_disabled`.
