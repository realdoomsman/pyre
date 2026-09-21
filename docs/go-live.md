# Go-live checklist

Every service is built, deployed and verified against the live stack. The only remaining work is funding and credentials — the two items under **Blocked on you**. Secrets live in `.secrets/keys.env` (git-ignored) and are already set on all three Railway services.

## Deployed

| Service | URL | State |
| --- | --- | --- |
| web | https://web-production-9f3ea.up.railway.app | live |
| api | https://api-production-17ab9.up.railway.app | live, `/health` → `{"ok":true}` |
| runner | internal worker | live, 11 queues registered, repeatables ticking |
| Postgres | `postgres.railway.internal` | schema applied by `prisma db push` on api boot |
| Redis | `redis.railway.internal` | queues + build-feed pub/sub |

Railway project `ship` (`a10a327a-eb63-471a-9aa5-2aa71c298de1`). Deploy with `railway up --service <api\|runner\|web> --ci`.

## Design

**1-bit pixel terminal.** Three type voices, strictly separated: Silkscreen (a bitmap face) for the wordmark, `display`/`h1`/`h2` and 8px uppercase labels; Inter for prose; JetBrains Mono for every number, address and hash. Nothing is rounded (every radius token is 0, so status indicators are square blocks). Depth is a hard 2px offset shadow, never a blur. Loading is a dithered checkerboard and a blinking block cursor, not a shimmer. One accent, spent on money: green = money in, red = supply destroyed, low-chroma grey-violet = agent status, amber = needs a human, blue = external reference. No glow washes, no gradient fills. The brand mark is a block arrow that has left a launch pad with the hatch still open, drawn on a 16x16 grid so it is pixel-exact at favicon size; `icons.tsx` stores each glyph as 16 rows of ASCII art compiled to integer-coordinate rects, so the source file is the sprite sheet.

## Verified against production

**Feature matrix** — `railway ssh --service api "node apps/api/scripts/feature-audit.mjs"`: **50 pass / 0 fail / 3 blocked on funding** across 53 features, covering launch lifecycle, money math, build gating, governance, hosting and the app runtime, the perimeter, workers and data integrity. The three blocked rows are Anthropic credits and treasury SOL, labelled as such.

**Platform API** — `/v1/stats` returns a live SOL price from Jupiter; `/v1/apps` sorts and paginates; `/v1/me` 401s without a Privy token; the Anthropic proxy rejects an unknown job token and a non-allowlisted model; `/v1/apps/:slug/candles` degrades to `[]` instead of failing the page.

**Frontend** — initial transferred JS on `/` is **154.6 kB** (was 1,088 kB gzipped, and 3.4 MB uncompressed on the wire because nothing precompressed existed). The wallet stack is one deferred chunk that loads on no route until sign-in, enforced by a build-time budget check. `node apps/web/scripts/audit.mjs` exits 0: accessibility 100 and zero console errors on all seven audited routes, CLS ≤ 0.092 everywhere (landing was 0.349 on mobile), perf 95-100.

**Perimeter** — `apps/api/scripts/security-check.mjs` scores **31 PASS / 0 FAIL** against the live API: unauthenticated access blocked on every authed route, cross-origin `/_pyre/*` mutations rejected, rate limits tripping with `Retry-After`, webhook replay returning `duplicate: true`, a 7-day-old Helius payload rejected as `stale_event`, oversized proxy bodies 413, `/metrics` 401 in public and 200 with the internal secret, and CSP/cookie flags present.

**Reliability** — the reconcile pass reports **5 checks, 0 drift** (JOBS, SANDBOXES, JOBTOKENS, LEDGER, FEES). The JOBTOKENS reaper was observed deleting 4 orphaned tokens from crashed builds. Every side-effecting worker pass is Redis-lock guarded, so a second instance cannot double-sweep fees or double-charge a budget.

**Tests** — 211 tests, `npm test`, ~5s, no network/DB/Redis/RPC/model access. They found three real defects (below).

**Build pipeline** — a real build runs in production end to end: sandbox boots on the prebuilt 4GB template, the repo/template lands, `npm ci` installs, `npm run build` and the Playwright smoke test pass, screenshots and the Lighthouse audit run, and the reviewer's policy gate evaluates the diff. It stops at exactly one place: the Anthropic credit balance.

**App hosting** — `/a/demo/` serves a deployed app with a strict CSP, injects `/_pyre/env.js`, and executes `functions/hello.js` in the QuickJS runtime with `ship.kv` persisting across calls. Flipping the app to `DORMANT` serves the "buy to revive" page and 503s its functions.

**Frontend** — every route renders with live data and zero page errors, Inter/JetBrains Mono load, no horizontal overflow at 390px, and `og.png` is served as a real 1200x630 share card.

## Bugs found and fixed while verifying

- **BullMQ rejected every enqueue.** This version refuses `:` in custom job ids, so `intake:<id>`, `launch:<id>`, `build:<id>`, `prReview:...`, `growth:...` and `scheduler:trade:...` all threw on `add()` — the pipeline would have died on the first real launch. All ids now use `-`, including the two admin cancel paths that removed by id.
- **Intake could hang a launch forever.** A provider failure left the app in `DRAFT` with the wizard polling indefinitely. Intake now retries three times with exponential backoff and, once exhausted, settles the app as `FAILED` with "Spec generation is unavailable right now. Nothing was launched or charged." plus a feed event, which the wizard already renders.
- **Candles 500s.** An unindexable mint took down the whole coin page; it now degrades to an empty series.
- **Node 22 broke pump-sdk.** Node 22's `cjs-module-lexer` cannot see anchor's `BN` export. All images are pinned to Node 24.
- **`.gitignore` excluded the build engine.** A bare `build/` rule silently kept `apps/runner/src/build/` out of every deploy.
- **Privy's Solana subpath needs explicit peers.** `@solana/kit`, `@solana-program/*` and `@solana/spl-token` are optional peers that npm installs non-deterministically; they are now declared.
- **Fonts were never loaded.** Inter and JetBrains Mono were referenced in the theme but never imported, so the entire UI rendered in fallback system sans.
- **Every build failed at sandbox bootstrap (OOM).** Three stacked ceilings, all measured in a live sandbox: V8's default old-space is only 259MB on the E2B `base` VM, the VM has 478MB RAM and zero swap (so even `npm ci` got OOM-killed with exit 137), and the template had no lockfile, forcing full registry tree resolution. Fixed with measured heap sizing, an added swapfile, a committed `template/package-lock.json` + `npm ci`, per-step timeouts, non-interactive git, and a prebuilt 4GB `pyre-builder` template.
- **The reviewer rejected every build on its own policy files.** The mechanical blocker scanned the whole diff, so it matched `XMLHttpRequest`/`eval()` inside the eslint config that BANS them and inside `CLAUDE.md` which documents them. It also treated the template's own local `<script src="/src/main.tsx">` as an external script. Hard blocks are now scoped to files that actually ship, and only off-origin script srcs count. Pinned by 9 regression tests, because a false positive here silently blocks every deploy forever.
- **A Redis outage hung every cached read.** The shared ioredis client used `maxRetriesPerRequest: null` with offline queueing, so cache commands never settled and the existing fallback-to-Postgres path was unreachable. The cache now has its own client with offline queueing disabled and a per-command deadline; measured 7ms fall-through.
- **`slugify()` could emit an invalid DNS label.** Hyphens were trimmed before the 40-char clamp, so truncating mid-word left a trailing `-`. That value becomes `<slug>.pyre.fun`, where a trailing hyphen breaks certificate issuance. Also stripped combining marks so "Über Café" is `uber-cafe`, not `u-ber-cafe`.
- **Prisma opened 97 connections per process.** The Railway container reports 48 vCPUs and Prisma sizes its pool as `cpus*2+1`, so two processes alone exceeded Postgres' limit and caused "too many clients already". Pools are now bounded explicitly (api 10, runner 25).
- **Lighthouse was silently broken.** `verify.ts` installed it unpinned; the current major uses import attributes that the sandbox's Node 20 cannot parse, so every audit failed with a `SyntaxError`. Pinned to a version that runs there.

## Demo content — remove before public launch

Three seeded apps (`inboxzero`, `shotcaller`, `deadlinks`) carry **fake revenue, buybacks and feed events** so the UI could be built and verified against realistic content, plus a `demo` hosting-check app. They appear on the public leaderboard. Purge both before you show the site to anyone:

```
railway ssh --service api "node apps/api/scripts/seed-demo-data.mjs --remove"
railway ssh --service api "node apps/api/scripts/seed-demo-app.mjs demo --remove"
```

Re-seed at any time with the same scripts minus `--remove`. `apps/api/scripts/probe-intake.mjs` pushes one real app through the intake queue and reports what the runner did with it — useful right after you add Anthropic credits.

## Blocked on you

1. **Anthropic credits.** The key is valid but the balance is `$0.00`; every agent call returns `credit balance is too low`. This is the only thing between you and a working build pipeline — everything around the model call is verified running in production.

   Builds are currently **paused** (`PlatformSetting.pause_builds = true`) so they stop burning E2B sandbox credits on jobs that can only fail at the model call. After you add credits, unpause and probe:

   ```
   railway ssh --service api "node -e \"import('@pyre/db').then(async({prisma})=>{await prisma.platformSetting.update({where:{key:'pause_builds'},data:{value:false}});await prisma.\$disconnect()})\""
   railway ssh --service api "node apps/api/scripts/probe-intake.mjs"
   ```

   The probe should return `SPEC_READY` with a generated spec. The same switch set back to `true` is your kill switch for all building.

   To keep credits topped up from fees instead of by hand, set `CREDITS_FUNDING_WALLET` (see hardening below): 30% of every app's fees is then swept SOL→USDC→that wallet.
2. **Treasury SOL.** `53pWcdTUE739ApddT1DfUQ1LQG9Wd63XNW4XF7aoLmPb` holds 0 SOL. It pays fees for creator-fee sweeps, buybacks, burns, stake refunds and bounty payouts. Fund with ~2 SOL. Its key derives from `PLATFORM_MASTER_SEED_HEX` (index 0) — back that seed up offline; losing it loses every per-app wallet.
3. **$PYRE mint.** `PYRE_MINT` is empty, so the $PYRE page shows its pre-launch state and the $PYRE share accrues in the treasury without being swapped or burned. Launch the coin, set `PYRE_MINT` and `VITE_SHIP_MINT`, redeploy api and web.
4. **X API keys (optional).** Empty, so the growth agent composes posts and records them to the feed marked `[X not connected]` instead of posting.

## Optional hardening

- **Custom domain.** Point `pyre.fun` at web, `api.pyre.fun` and wildcard `*.pyre.fun` at api, then set `APP_DOMAIN=pyre.fun` and `VITE_APP_DOMAIN=pyre.fun`. Apps move from `/a/<slug>/` to `<slug>.pyre.fun` with no code change. Add the new origins to Privy.
- **Privy production mode.** The app is in development mode; allowed origins are already restricted.
- **E2B template (measured, big win).** `E2B_TEMPLATE=pyre-builder` is already built and published (`npx tsx apps/runner/scripts/build-e2b-template.ts pyre-builder` — builds server-side, no Docker, ~2 min). Measured against the app template: bootstrap 115s → 22s, verify 255s → 91s, and the VM gets 4GB instead of base's 478MB. It is set in production; the stock `base` path still works as a fallback.
- **GitHub webhooks.** `GITHUB_WEBHOOK_SECRET` is set; add the webhook to each `pyre-<slug>` repo pointing at `POST /v1/webhooks/github` so holder PRs trigger review.
- **Pinata.** Set `PINATA_JWT` to pin coin metadata on IPFS; otherwise it is served from `GET /v1/meta/:appId.json`.
- **Credit-funding wallet (fees pay for compute).** `CREDITS_FUNDING_WALLET` is empty, so the credits slice accrues on the `CREDITS` ledger without leaving the treasury. To close the loop: (1) get a stablecoin/crypto card with a Solana USDC deposit address (KYC), (2) set it as Anthropic's billing method in the Console with auto-reload, (3) set `CREDITS_FUNDING_WALLET` to the card's deposit address and redeploy the runner. `feeSweep` then swaps the accrued credits SOL→USDC and transfers it there each pass (min $25). Tune the slice with `CREDITS_FUNDING_BPS` (default 5000 = half the build cut; 0 disables). Anthropic has no credit-purchase API, so the card auto-reload is the only automated bridge and its real charges can't be exercised from CI.

## First real launch

1. Add Anthropic credits and fund the treasury.
2. Purge the demo content.
3. Sign in on the web app (X, email or wallet; an embedded Solana wallet is created).
4. `/launch`: name, ticker, image, prompt → the intake agent writes a spec → approve it → sign the refundable 0.05 SOL stake.
5. The launch worker creates the coin on pump.fun and flips the app to `LIVE`.
6. `feeSweep` collects creator fees every 5 minutes and credits 60% to the build budget.
7. At $50 of accrued budget the scheduler starts the first build; watch it stream on the coin page.
8. App revenue routes to `buyback`, which swaps and burns every 10 minutes and writes the attestation hash into the transaction memo.
