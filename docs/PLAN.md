# Pyre — master plan

Pyre (Solana / pump.fun) → **Pyre** (Robinhood Chain / PONS v2). Same loop — a coin's creator fees fund an AI agent that builds an app; the app's revenue buys the coin back and burns it — rebuilt on EVM with a new identity, a new UI, a new repo, and a full X presence. This document is the single source of truth for the cutover. It is executed by parallel agents; every wave ends with an audit gate.

## 0. Ground truth (verified 2026-09-21)

**Chain.** Robinhood Chain, chain id `4663`, Arbitrum Nitro, ~0.1 s blocks, native ETH, base fee ≈0.05 gwei. Public RPC `https://rpc.mainnet.chain.robinhood.com` (rate-limited, no WSS); Alchemy recommended for prod. Explorer Blockscout `https://robinhoodchain.blockscout.com` (WAF 403s bare Node fetch — send browser-like headers). Stablecoin: **USDG** `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec, EIP-3009 + EIP-2612, EIP-712 domain "Global Dollar"/"1"). No canonical USDC.

**PONS v2 (the only launch path).** v1 factory `0xA5aA…1feB` has `launchEnabled=false`; every recent direct call reverts `NotWhitelisted`. v2 is live and open (`canLaunch(any)=true`, ~1,600 launches / 200k blocks):

| Contract | Address |
|---|---|
| Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Launch-and-buy router | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |
| Fee escrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` |
| Meme hook (v4) | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| Buyback vault | `0x42df2a798f82289E177311362e8f5ccC45c1219c` |
| Launch locker | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` |
| Uniswap v4 PoolManager / Universal Router / V4Quoter / StateView | see `local://research-chain.md` §dex |

Mechanics: `factory.launchToken(TokenParams{name,symbol,logo,description,socials,creatorFeeRecipient,creatorTaxBps,buybackEnabled,expectedEconomics,salt}, launchConfigId=0, pairToken=0x0)` with `value=launchFee()` (0.0005 ETH). Supply 1e9 minted to a per-launch bonding curve; `curve.buy(quoteIn,minOut,recipient)` / `curve.sell(...)`; graduates at 4.2 ETH into a Uniswap v4 pool (fee 0, hook fee 1%). Creator gets 70% of the 1% base fee + 100% of creator tax. Fees accrue on the curve (`quoteFeeBalance`) / hook (`pendingFees`), are swept (`curve.sweepFees` / `hook.sweepPoolFees`, creator or operator) into the **FeeEscrow**, and the creator pulls with `escrow.claim()` (ETH ledger). v2 launch tokens are `ERC20Burnable` — `burn()` reduces `totalSupply`. Events: `TokenLaunched`, `CurveBuy`, `CurveSell`, `PoolGraduated`, v4 `Swap`. Candles: GeckoTerminal network `robinhood`, dex `pons-v2` (curves) / `pons-v2-dex` (v4 pools). Holders: Blockscout `/api/v2/tokens/{addr}/holders`.

**Codebase.** npm workspaces, Node 24, TypeScript, Prisma/Postgres, BullMQ/Redis, Express API, React 19 + Vite 6 + Tailwind v4 + TanStack Query + lightweight-charts, E2B + Claude Agent SDK build pipeline, QuickJS app runtime. Auth is Google ID token or external-wallet challenge → platform JWT; wallets are **custodial HD keys** derived from `PLATFORM_MASTER_SEED_HEX` (server signs, browser never does). Payments are custodial USDC transfers to the treasury (checkout + "x402"). Maps: `local://map-chain-shared.md`, `local://map-api-runner.md`, `local://map-web-docs.md`.

**Accounts.** GitHub `realdoomsman` (gh CLI), Railway project `ship`, domain `pyre.fun` (Porkbun), X account created, user's EVM wallet `0x84F8E5a324466Deb7447048C014CF0245ce04afA` (connected to PONS in their browser).

## 1. Product decisions (locked)

1. **Every Pyre coin is a PONS v2 launch.** Sender = the app's derived wallet (so PONS shows it as creator and salts are namespaced per app); `creatorFeeRecipient` = same wallet; `creatorTaxBps = 0`; `buybackEnabled = false` (Pyre does its own buy-and-burn, on-chain and attributable). Treasury pre-funds the app wallet with launch fee + gas.
2. **Fee sweep** every 5 min per LIVE app: try `curve.sweepFees(0)` (pre-grad) / `hook.sweepPoolFees(poolId,0,0)` (post-grad) from the app wallet; on `InternalSwapRequiresOperator` fall through (PONS operator sweeps); then `escrow.balanceOf(appWallet)` → `escrow.claim()`. Claimed ETH → `FeeEvent{wei, ethPriceUsd}` → split **60/25/15** (build budget / $PYRE buyback / launcher) exactly as before, USD micros computed from ETH price (DeFiLlama `coins.llama.fi`). Unswept balances (`quoteFeeBalance`, `pendingFees`) are displayed as "accruing".
3. **Buyback + burn** every 10 min when pending revenue ≥ $5: pre-grad `curve.buy(wei, minOut, treasury)` then `token.burn(amount)`; post-grad Universal Router v4 exact-in swap ETH→token to treasury then `token.burn()`. Attestation: a zero-value self-tx from the treasury whose calldata is `0x5059524501 || sha256(revenueEventIds)` ("PYRE" + version + hash) — verifiable on Blockscout; `Buyback.attestTx` stores it. Burned supply is read from `totalSupply()` delta (v2 tokens actually burn).
4. **Stake** stays refundable, denominated in ETH: `LAUNCH_STAKE_WEI = 0.05 ETH` (≈$135) — spam control only.
5. **App payments in USDG** via EIP-3009 `transferWithAuthorization` relayed by the treasury (user custodial wallets never need gas). Same custodial checkout / per-call / holder-tier / ad models. Revenue split stays **85/10/5**.
6. **Trading inside Pyre.** Custodial users: deposit ETH to their Pyre address (bridge link), buy/sell via server-signed curve/v4 txs, withdraw. External-wallet users: sign in-browser (wagmi/viem) against the same curve/router. Always show a "Trade on PONS" deep link too.
7. **$PYRE** is itself a PONS v2 launch made from the treasury wallet (`PYRE_MINT` → `PYRE_TOKEN`). Its 25% fee share and 10% revenue share are swapped and burned like any app coin.
8. **Auth**: keep Google + external-wallet challenge (EIP-191 personal_sign), custodial EVM HD wallets `m/44'/60'/0'/0/{index}`. No Privy.
9. **Identity**: Option B "Obsidian Temper" palette, Instrument Serif + Geist + Geist Mono, heat-not-flame. See §4.

## 2. Waves

Each wave is a batch of parallel agents with disjoint file ownership. Nobody runs the full build/test mid-wave; the gate does.

### Wave 1 — foundations (parallel)
| Agent | Owns | Deliverable |
|---|---|---|
| **ChainCore** | `packages/chain/**` | Rewrite on viem: `pyreChain` definition, clients, HD signers (`deriveWallet(index)`, `treasury`), `ethPriceUsd()`, native/ERC-20/EIP-3009 transfers + receipt verification, PONS v2 client (`launchToken`, `readLaunch`, `curveQuote`, `buy/sell`, `sweepFees`, `escrow.claim`, `getLaunchedToken`, phases, `graduationProgress`), v4 swap via Universal Router, `burn`, `attestBurn`, holders (Blockscout), candles (GeckoTerminal + own CurveBuy/Sell indexer), token info. Unit tests with mocked clients. |
| **SharedDb** | `packages/shared/**`, `packages/db/**` | Economics in wei/ETH (`usdMicrosFromWei`, `weiFromUsdMicros`), constants (`LAUNCH_STAKE_WEI`, `PYRE_*`, `RESERVED_SLUGS`), schemas (0x addresses, tx hashes), Prisma schema rename/retype (`mint`→`tokenAddress`, `creatorWallet`→`walletAddress`, `*Lamports`→`*Wei`, `txSig`→`txHash`, `solPriceUsd`→`ethPriceUsd`, `poolAddress`→`curveAddress`+`poolId`, add `App.launchPhase`, `Buyback.attestTx`, `Buyback.burnedUnits`), one squashed migration, `.env.example`, root package/tsconfig/vitest env. |
| **DesignSystem** | `apps/web/src/index.css`, `apps/web/src/ui/**`, `apps/web/index.html`, `apps/web/src/lib/format.ts`, fonts | Tokens (Option B), type ramp, motion tokens, primitives: Button, Chip, Card, Sheet/Tray, Tabs, Table, NumberFlow (digit roller), TickFlash, HeatGauge, SupplyKiln, Sparkline, Console frame, Toast (sonner), CommandK, Skeletons, EmptyState (ash). Storybook-less gallery route `/_ui`. |
| **Brand** | `marketing/brand/pyre/**` | Wordmark + mark v2 (heat, not flame; tempered violet on obsidian), PFP 1024, banner 1500×500, OG 1200×630, favicon set, `BRAND.md` v2. |

Gate 1: `npm run build` for shared/db/chain, `npm test` for those packages, `/_ui` renders every primitive, brand assets reviewed visually.

### Wave 2 — services (parallel, after Gate 1)
| Agent | Owns | Deliverable |
|---|---|---|
| **ApiCore** | `apps/api/src/{env,auth,routes/(me,launches,apps,ship,admin,stats,meta,webhooks),lib}` | EVM auth (personal_sign challenge), wallet balances (ETH/USDG/tokens), launch flow (`stake` = ETH transfer verify), stats in ETH, `/rpc` → JSON-RPC read proxy with allowlist, Blockscout webhook removal (poll instead), $PYRE routes. |
| **ApiHost** | `apps/api/src/host/**`, `packages/app-sdk/**`, `template/**` | USDG EIP-3009 checkout + per-call, holder tier via `balanceOf`, env.js (`chainId`, `usdg`, `treasury`), SDK rename `@pyre/app-sdk`, template CLAUDE.md/deps/local host. |
| **Runner** | `apps/runner/src/**` | Workers: launch (PONS v2), feeSweep (sweep+claim+split), buyback (buy+burn+attest, pre/post-grad), price (curve reserves / v4 slot0 + ETH oracle), holders (Blockscout), candles indexer, scheduler thresholds unchanged, reconcile checks (escrow vs FeeEvent, burn vs totalSupply), credits funding (ETH→USDG→card, or disabled), growth copy. Remove Zentro/Playwright from runner image. |

Gate 2: full `npm run build`, `npm test` green, API boots against local Postgres/Redis, feature-audit + security-check scripts updated and passing locally, a dry-run launch on Robinhood Chain from a funded test wallet (real PONS v2 launch of a throwaway coin, sweep, buy, burn, attest — recorded tx hashes in `docs/go-live.md`).

### Wave 3 — web (parallel, after Gate 1; integrates after Gate 2)
| Agent | Owns | Deliverable |
|---|---|---|
| **WebShell+Home** | `apps/web/src/{App,routes,layout,pages/Home,components/feed}` | Nav with Proof Strip, ⌘K, ranked feed (Trending · New · Heating · Graduated · Shipping · Burning), coin cards with graduation ring + heat index + agent status, right rail live tape (SSE), Live Build Hero, mobile bottom bar, marketing landing sections with Loop Spine. |
| **WebCoin** | `apps/web/src/pages/Coin/**` | Coin page: header, odometer MC, chart (lightweight-charts candles + MCap/USD toggles + burn markers), Supply Kiln, loop status panel, tabs (Build log · App · Burn ledger · Holders · Trades · Thread), Buy/Sell panel (custodial + external wallet), Stats/Audit, fee-transparency table, graduation ring. |
| **WebLaunch+Account** | `apps/web/src/pages/{Launch,Account,Profile,Ship,Apps,Ops,Legal}/**` | 3-step launch trays with live preview + agent brief + Ignition screen; account (deposit/withdraw ETH & USDG, positions, claimable, launched coins, "your share grows"); $PYRE page; app store; ops; legal pages rewritten for Robinhood Chain. |

Gate 3: `node apps/web/scripts/audit.mjs` (perf ≥ 90, a11y 100, no console errors) on every route at 1440 and 390, visual review screenshots of every page, no Solana strings (`grep -ri "solana\|pump\.fun\|lamport\|SOL\b"` → 0 in src).

### Wave 4 — ship
1. Rename scope `@pyre/*` → `@pyre/*`, `pyre`→`pyre` everywhere (cookies, headers, slugs, reserved words), README/docs rewrite (architecture, economics, runbook, go-live, legal/terms/privacy/content-policy for Robinhood Chain).
2. New GitHub repo `realdoomsman/pyre` (public, MIT), history squashed to one initial commit (secrets audit first: `.secrets/`, `.tmp/`, `_cliprof` excluded).
3. Railway: new project `pyre` (api, runner, web, Postgres, Redis), env set, Alchemy RPC, `PLATFORM_MASTER_SEED_HEX` (new seed, backed up to `.secrets/`), custom domains `pyre.fun`, `api.pyre.fun`, `*.pyre.fun` → Porkbun DNS (API keys from the user's Porkbun account or via the logged-in browser).
4. Launch `$PYRE` on PONS v2 from the treasury; set `PYRE_TOKEN`.
5. Final audits: feature-audit, security-check, reconcile, web audit, OWASP pass by the `security-reviewer` agent, code review by `reviewer` agent, fix everything found.

### Wave 5 — X presence (after Wave 4)
Article (long-form, with real screenshots, tx hashes, diagrams, tables), pinned post, promo video (ffmpeg composition of real UI captures + motion text + voice-over/music), ~20 supporting posts with custom visuals, engagement with Robinhood Chain / PONS / launchpad / AI-agent accounts. All posted through the user's logged-in browser via the relay.

## 3. Interface contracts (so agents don't negotiate)

**`@pyre/chain` public surface (ChainCore → everyone):**
```ts
export const pyreChain: Chain;                          // viem chain def (4663)
export function publicClient(): PublicClient;           // http(RPC_URL) with retry
export function deriveWallet(index: number): { address: Address; account: PrivateKeyAccount }; // m/44'/60'/0'/0/index
export function treasury(): { address: Address; account: PrivateKeyAccount };                  // index 0
export function walletClient(account): WalletClient;
export function getEthPriceUsd(): Promise<number>;      // cached 30s
export function getEthBalance(addr): Promise<bigint>; getErc20Balance(token, addr): Promise<bigint>;
export function transferEth(from, to, wei): Promise<Hash>; transferErc20(from, token, to, units): Promise<Hash>;
export function relayUsdgAuthorization(auth: Eip3009Auth): Promise<Hash>;  // treasury pays gas
export function signUsdgAuthorization(account, to, units, validBefore): Promise<Eip3009Auth>;
export function verifyEthTransfer(hash, { to, minWei, from? }): Promise<{ ok, from, wei }>;
export function verifyErc20Transfer(hash, { token, to, minUnits }): Promise<{ ok, from, units }>;
// PONS v2
export function launchPonsToken(account, params: { name, symbol, logo, description, socials?, creatorFeeRecipient, salt? }): Promise<{ hash, token, curve }>;
export function readLaunch(token): Promise<LaunchRecord>;   // factory.getLaunchedToken + curve reads; phase 0..3
export function curveQuoteBuy(curve, wei, recipient): Promise<{ tokensOut, spent, refund }>; curveQuoteSell(curve, tokens): Promise<bigint>;
export function curveBuy(account, curve, wei, minOut, recipient): Promise<{ hash, tokensOut }>; curveSell(...)
export function v4SwapExactIn(account, launch, { ethIn | tokensIn }, minOut, recipient): Promise<{ hash, out }>;
export function sweepCreatorFees(account, launch): Promise<{ swept: boolean, hash? }>;  // tolerant of InternalSwapRequiresOperator
export function claimEscrow(account): Promise<{ hash, wei }>;  // 0n if nothing
export function accruingFees(launch): Promise<{ unsweptWei: bigint; escrowWei: bigint }>;
export function burnTokens(account, token, units): Promise<Hash>;
export function attestBurn(account, hash32: Hex): Promise<Hash>;
export function getTokenInfo(token): Promise<TokenInfo>;     // name symbol logo description socials totalSupply burned
export function getPrice(launch): Promise<{ priceEth: number; priceUsd: number; mcapUsd: number; progress: number }>;
export function getHolders(token, limit): Promise<Holder[]>;
export function getCandles(launch, interval, limit): Promise<Candle[]>;
export function getTrades(launch, sinceBlock): Promise<Trade[]>;
export const attestationHash: (ids: string[]) => Hex;
```

**DB renames (SharedDb → ApiCore/Runner/Web):** `User.wallet/authWallet` (0x), `App.tokenAddress`, `App.walletAddress`, `App.curveAddress`, `App.poolId`, `App.launchPhase Int`, `App.launchTx/stakeTx/stakeRefundTx` (0x hash), `App.stakeWei/feesWei/buybackWei`, `FeeEvent.wei/ethPriceUsd/txHash`, `Buyback.ethWei/swapTx/burnTx/attestTx/burnedUnits`, `Purchase.txHash/payerWallet`, `Bounty.wei/escrowTx/payoutTx`, `CreditFunding.ethWei/...`. Amount semantics: USD = micros (bigint), ETH = wei (bigint), tokens = base units 1e18 (bigint), USDG = 1e6 units.

**API DTO changes (ApiCore → Web):** `mint`→`tokenAddress`, `buybackSol`→`buybackEth`, `feesSol`→`feesEth`, `stakeSol`→`stakeEth`, `curveStage`→`phase` (0 curve, 2 pool), `pumpUrl`→`ponsUrl` (`https://www.ponsfamily.com/launchpad/<token>` — verify format), add `explorerUrl`, `progress` (0–1), `graduationThresholdEth`.

**Env (SharedDb):** `RPC_URL`, `RPC_WSS_URL?`, `CHAIN_ID=4663`, `PLATFORM_MASTER_SEED_HEX`, `PYRE_TOKEN?`, `USDG_ADDRESS`, `PONS_FACTORY`, `PONS_LAUNCH_AND_BUY`, `PONS_FEE_ESCROW`, `PONS_MEME_HOOK`, `UNIV4_UNIVERSAL_ROUTER`, `UNIV4_QUOTER`, `UNIV4_STATE_VIEW`, `BLOCKSCOUT_URL`, `GECKOTERMINAL_URL`, `TREASURY_WALLET` (derived, informational). Removed: everything `SOLANA_*`, `HELIUS_*`, `USDC_MINT`, `PYRE_MINT`, `ZENTRO_*`.

## 4. Identity (locked)

- **Idea**: heat, not flame. Fire shown through consequence: supply shrinking, metal tempering, paper charring.
- **Palette "Obsidian Temper"**: canvas `#0A0A0C`, surface `#121215`, raised `#18181D`, line `rgba(255,255,255,.07)`, ink `#F3F2EE`, ink-2 `#9B9891`, ink-3 `#62605B`, accent `#9D8CFF`, accent-strong `#7A66F5`, build `#3E8BFF`, earn `#4FD1A6`, burn `#FF4D6D`, warn `#E5C15C`, white-hot `#E9F1FF`. Heat ramp `#1C1B2E → #3B2F7A → #7A66F5 → #3E8BFF → #9CD2FF → #E9F1FF`. Light theme (app store/docs): "Ash Paper" `#F4F1EA` / ink `#141311` / cobalt `#1F3DE8`.
- **Type**: Instrument Serif (display, 400, -0.02em, italic for the one emphasized word), Geist Sans (UI, cap 600, tabular nums), Geist Mono (numbers, addresses, ledger, labels +0.04em uppercase).
- **Motion**: 140ms `cubic-bezier(.4,0,.2,1)` UI; 400ms `cubic-bezier(.25,1,.5,1)` reveals; 900ms `cubic-bezier(.19,1,.22,1)` scenes; springs 260/26 for trays; heat animations white-hot → accent over 1.2s. Reduced-motion respected.
- **Signature moments to ship**: Ignition (launch success), Supply Kiln (coin page), Heat Index (feed), Live Build Hero (home), Cooling Ledger Rows (burn ledger), Proof Strip (nav), Ash & Relight (dormant apps), Your Share Grows (account).
- **Mark**: a tempered square — an obsidian tile whose lower edge glows through the heat ramp; wordmark "Pyre" in Instrument Serif. No flame glyph, no orange, no lime.

## 5. Audits along the way

| When | What |
|---|---|
| Gate 1 | package builds + unit tests; visual review of `/_ui`; brand review |
| Gate 2 | full build/test; API boot; feature-audit + security-check locally; **real on-chain dry run** (launch → sweep → buy → burn → attest) with hashes recorded |
| Gate 3 | Lighthouse/a11y audit on all routes at 1440/390; screenshot review; zero Solana strings; keyboard nav; reduced-motion |
| Wave 4 | `security-reviewer` agent pass; `reviewer` agent pass; reconcile 0 drift in prod; production smoke of every route; DNS + TLS on `pyre.fun` |
| Wave 5 | every post rendered and proofread before publishing; links resolve; no financial-advice language |

## 6. Risks

- PONS docs say v2 public launches are gated; chain says open. Runner checks `canLaunch(appWallet)` before every launch and surfaces a clear `LAUNCH_GATED` state instead of failing silently.
- v2 is unaudited (three reviews in progress). Treasury holds minimal ETH; sweeps/buybacks are bounded per pass.
- Post-graduation sweeps that need internal swaps are operator-only; Pyre relies on PONS operator cadence for those and shows accruing balances honestly.
- Public RPC rate limits: all chain reads go through a cached, batched client; prod uses Alchemy.
- Universal Router v4 swap path not yet executed on this chain — Gate 2 dry run covers it (or falls back to `PoolSwapTest`-style direct PoolManager unlock via a tiny helper contract if the router is missing).

## 7. Status (2026-09-21)

**Shipped.**

- Waves 1–3: `@pyre/chain` on viem (PONS v2 factory/curve/escrow/hook, Uniswap v4 quoter + Universal Router, USDG EIP-3009 relay, burn + `0x5059524501‖sha256` attestation, Blockscout holders, on-chain trade/candle indexer); `@pyre/shared`/`@pyre/db` in wei/USDG with the squashed migration; API on Google + EIP-191 auth with custodial HD wallets (`m/44'/60'/0'/0/<user>`, `m/44'/60'/1'/0/<app>`), `POST /v1/rpc` read allowlist, USDG checkout/per-call; runner workers `launch` (with `LAUNCH_GATED` + 10 min retry), `feeSweep` (sweep → claim → 60/25/15 split → credits funding), `buyback` (curve or v4 → `burn()` → attest), `price`, `holders`, `market`, six-check `reconcile`; web on the Obsidian Temper system with all routes (`/`, `/launch`, `/c/:slug`, `/apps`, `/burns`, `/me`, `/pyre`, `/governance`, `/ops`, `/status`, `/legal/:doc`, share cards, `/_ui`). Only GitHub remains as an inbound webhook.
- Wave 4: scope renamed to `@pyre/*`; public repo `realdoomsman/pyre`; Railway project `pyre` (api, runner, web, Postgres, Redis) live on `pyre.fun` / `api.pyre.fun` / `*.pyre.fun` with valid certificates; E2B template `pyre-builder` built and set; new `PLATFORM_MASTER_SEED_HEX` (treasury `0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54`, backed up in `.secrets/pyre-keys.env`); README, architecture, economics, runbook, go-live and legal docs rewritten for Robinhood Chain; `npm run build` green, `npm test` 349 passing.

**Open** (see `docs/go-live.md`): treasury ETH funding, Anthropic credit balance check, `$PYRE` launch + `PYRE_TOKEN`, optional Alchemy / Blockscout / X keys, demo-data purge, and the production audits (feature-audit, security-check, web audit, on-chain dry run with recorded hashes). Wave 5 (X presence) not started.
