# Pyre economics

All constants live in `packages/shared/src/constants.ts`. Percentages are basis points (10 000 = 100%). Three units, never mixed: USD as micros (1 000 000 = $1), the app's **native asset in base units** (wei, 10^18 = 1 ETH, on Robinhood Chain; lamports, 10^9 = 1 SOL, on Solana — every `…Wei` column and field means "native base units of the app's chain"), coin balances in the coin's base units (18 decimals on PONS v2, 6 decimals on pump.fun). JSON carries every bigint as a decimal string, and every app DTO carries `chain`, `launchpad` and `native: { symbol, decimals }` so a reader never has to guess the unit.

## Venues

A venue is a chain + launchpad pair. Pyre runs two, behind one adapter interface (`packages/chain/src/venue.ts`, registry `VENUES` in `@pyre/shared`):

| Venue | Chain | Launchpad | Native | Coin | Supply | Curve → pool |
| --- | --- | --- | --- | --- | --- | --- |
| `pons_v2` | Robinhood Chain (chain id 4663) | PONS v2 | ETH | ERC-20, 18 decimals, `ERC20Burnable` | 1 000 000 000 | graduates at 4.2 ETH into a Uniswap v4 pool |
| `pump_fun` | Solana (`SOLANA_CLUSTER`: `mainnet-beta` or `devnet`) | pump.fun | SOL | Token-2022 mint, 6 decimals, no mint or freeze authority | 1 000 000 000 | graduates at ≈ 85 SOL raised into a PumpSwap pool |

The launcher picks the venue in step 1 of the launch flow; `App.chain` and `App.launchpad` are fixed for the life of the coin. Everything downstream — stake, fee claims, splits, burns, trading, holders, candles — dispatches on that pair. The Solana venue exists only when `SOLANA_RPC_URL` is set (and `PUMP_LAUNCH_ENABLED` is not `false`); `GET /v1/venues` reports which venues are on.

**$PYRE is one coin on Robinhood Chain.** It is a PONS v2 launch and nothing else: it is not bridged, wrapped, mirrored or relaunched on Solana or anywhere else, and any $PYRE on another chain is not us. That single fact shapes the Solana economics below.

## Where a coin comes from

### Robinhood Chain · PONS v2

A Robinhood coin is a **PONS v2** launch. The launch is sent from the app's own derived wallet (`App.walletAddress`, HD path `m/44'/60'/1'/0/<index>`), so PONS records that wallet as the creator and as `creatorFeeRecipient`. The treasury pre-funds that wallet with the PONS launch fee (`PONS_LAUNCH_FEE_WEI`, 0.0005 ETH) plus gas. `creatorTaxBps` is 0 and PONS's own buyback flag is off: the only buy-and-burn Pyre runs on Robinhood Chain is of $PYRE, and it is attested.

The whole supply (`PONS_TOTAL_SUPPLY`, 1 000 000 000 tokens) is minted to a per-launch bonding curve. Buys and sells on the curve pay a 1% fee. When the curve has raised `PONS_GRADUATION_THRESHOLD_WEI` (**4.2 ETH**) it closes and liquidity moves into a **Uniswap v4** pool whose hook charges the same 1% on every swap. In both phases **70% of that 1% goes to the creator wallet** — the app — and the remaining 30% stays with PONS. There is no team allocation, no pre-mine and no launcher supply: every token is bought on the curve or in the pool like anyone else's.

### Solana · pump.fun

A Solana coin is a **pump.fun** `create_v2` launch. The launch is sent from the app's own derived Solana wallet (`App.walletAddress`, base58, SLIP-0010 ed25519 path `m/44'/501'/<1000000 + index>'/0'`), which signs and pays and is passed as the coin's `creator` — so pump.fun's `BondingCurve.creator`, and therefore the creator vault, is that wallet. The mint is a fresh keypair (`App.tokenAddress`). The treasury Solana wallet pre-funds the app wallet with `predictLaunchCost` (≈ 0.005 SOL of rent; pump.fun charges no platform fee to create) plus a gas float. The coin's metadata JSON is hosted by Pyre at `GET /v1/apps/:slug/metadata.json` (`name`, `symbol`, `description`, `image`, `createdOn: "https://pyre.fun"`, website), not pinned to IPFS. No initial buy is made; every token is bought on the curve or in the pool like anyone else's.

The 1 000 000 000 supply sits on pump.fun's bonding curve (6-decimal Token-2022 mint, mint and freeze authority null) until ≈ 85 SOL has been raised (793.1M tokens sold), then pump.fun migrates it into the canonical **PumpSwap** pool. Creator fees are what pump.fun pays the creator: **30 bps of every curve trade**, and on the canonical pool a **market-cap-tiered share** that starts at 0.30%, steps up to 0.95% and then declines to 0.05% as the coin grows (the tiers are read live from pump.fun's fee program). These rates are pump.fun's, not Pyre's: pump.fun sets them, has changed them before, can change them again, and its terms say creator fees carry no warranty and can be re-routed under its community-takeover (CTO) process. Pyre reads whatever accrues and never assumes a rate.

`App.launchPhase` on Solana mirrors the PONS phases: `0` on the curve, `1` curve complete and pool not yet created (pump.fun's backend migrates), `2` trading on PumpSwap.

## One money stream per app

Creator fees, in the app's native asset, are the only money an app ever has. The app itself is free to use: there is no checkout, no subscription, no per-call price and no ad slot inside a Pyre app, and nothing an app's users do moves money.

On Robinhood Chain fees accrue on the curve (`quoteFeeBalance`) or on the v4 hook (`pendingFees`); Pyre shows those as *accruing*. Every 5 minutes `feeSweep` sweeps them into the PONS **FeeEscrow** (`curve.sweepFees` pre-graduation, `hook.sweepPoolFees` after; when a post-graduation sweep needs an internal swap only the PONS operator may run it and Pyre waits) and then `escrow.claim()`s the balance to the app wallet.

On Solana fees accrue in the creator vault (a PDA of the pump program keyed by the creator wallet) on the curve and in the creator's WSOL vault on PumpSwap after graduation; there is no sweep step (`sweepFees` is a no-op on pump.fun). Every 5 minutes `feeSweep` calls `collect_creator_fee` and `collect_coin_creator_fee` from the app wallet — both permissionless, and because the payer is the creator the WSOL is unwrapped in the same transaction — so claimed SOL lands in the app wallet.

On either chain each claim is a `FeeEvent { wei, ethPriceUsd }` — native base units and the native/USD price at claim time (ETH from DeFiLlama; SOL from Jupiter price v3 with a CoinGecko fallback, cached 60 s) — and split by `FEE_SPLIT_BPS_BY_CHAIN[chain]`.

| Split | Robinhood Chain | Solana |
| --- | --- | --- |
| 60% | Build cut: `BUILD:<appId>` (spendable budget) and `CREDITS:<appId>` (model-credit funding), 50/50 | same |
| 25% | `PYRE_TOKEN` — $PYRE buyback + burn | `COINBURN:<appId>` — buyback + burn of **the app's own coin** |
| 15% | `LAUNCHER:<userId>` — the person who launched the coin | same |

The 25% leg differs because $PYRE cannot be bought on Solana: it lives on Robinhood Chain only, and Pyre does not bridge fees between chains. So on Solana the same quarter buys the coin whose fees paid for it and burns it (see *Coin burns* below). A Solana coin's fees never buy $PYRE, and a Robinhood coin's fees never buy any app coin.

Forks send `FORK_ROYALTY_BPS` (10%) of their creator fees upstream to the original app, forever, before the split above. Human contributors are paid through bounties (`Bounty`, ETH escrowed in the treasury and released on a merged PR), not through a fee-stream carve-out.

The 60% build cut is split by `CREDITS_FUNDING_BPS` (5000 = 50%) into the coin's spendable build budget (`BUILD:<appId>`) and a credits-funding slice (`CREDITS:<appId>`). Both are **per-coin**: a coin can only ever fund, and therefore spend, credits its own fees earned — a coin that earned $0 gets $0 of compute, and one coin's balance can never be spent by another.

## Worked example: $10 000 of trading volume

At a 1% trade fee with 70% to the creator, $10 000 of volume on Robinhood Chain sends **$70.00** of ETH to the app wallet.

- Creator fee claimed: `FeeEvent.wei` worth **$70.00** at `ethPriceUsd` (from `getEthPriceUsd()`, DeFiLlama, cached 30 s)
- Build cut: 60% = **$42.00**, split 50/50 → spendable build budget **$21.00** (`App.budgetMicros += 21 000 000`) and credits funding **$21.00** (`CREDITS:<appId>` ledger)
- $PYRE buyback: 25% = $17.50
- Launcher: 15% = $10.50

On Solana the same $10 000 of curve volume pays the creator 30 bps: **$30.00** of SOL, claimed to the app wallet and split $18.00 build cut ($9.00 budget, $9.00 credits), $7.50 to `COINBURN:<appId>`, $4.50 to the launcher. After graduation the pool tier applies instead (0.30%–0.95% by market cap, at pump.fun's discretion), so the same volume can pay anything from $30 to $95. The thresholds below are in USD and identical on both chains, so a Solana coin needs more volume to reach them at today's rates.

The first build starts at `MIN_BUILD_BUDGET_USD` = $50 of accrued spendable budget, i.e. roughly **$24 000 of volume** on Robinhood Chain and **$56 000 of curve volume** on Solana at the rates above. Iterations run whenever budget ≥ `ITERATION_BUDGET_USD.MIN` ($10), spend up to `DEFAULT` ($25) and never more than `MAX` ($50) per job. Budget is debited by the **actual** metered cost of the job (proxy usage × model price), not the cap.

## Launch stake

Launching requires a stake in the native asset of the venue, `LAUNCH_STAKE_BY_CHAIN`: **0.05 ETH** on Robinhood Chain (≈$135), **1 SOL** on Solana (≈$117). It is spam control, nothing else: it does not pay for the launch (the treasury does) and it is refunded in full to the launcher's wallet on that chain (`App.stakeRefundTx`) when the app first reaches the $50 build threshold, or immediately if the launch fails. Custodial users stake with one click from their Pyre balance on that chain; external-wallet users on Robinhood Chain send 0.05 ETH to the treasury and submit the transaction hash, which the API verifies on-chain through the venue adapter (`verifyNativeTransfer`) before accepting it. On Solana the stake is always custodial: deposit SOL to your Pyre Solana address and stake from it. A stake is not refunded for an app killed under the content policy.

## What the budget pays for

- Agent build jobs (metered through the Anthropic proxy per `JobToken`).
- `pyre.llm()` calls made by the app's server functions, at cost.
- Growth: LLM composition cost plus $0.05 per published X post.

Budget under $10 → `DORMANT`. The app is served as an "out of budget — buy to relight" page. Any new creator fee, or a direct top-up in ETH (`POST /v1/apps/:slug/topup`, 100% to budget), relights it. A global daily compute ceiling (`GLOBAL_DAILY_COMPUTE_CEILING_USD` = $2 000) caps platform-wide spend regardless of budgets.

## Holder features

Apps are free. The one thing a coin unlocks inside its app is a **holder tier**: the app can gate a feature behind holding at least N of the coin, and the host reads the coin's `balanceOf` for the wallet on the account to decide. Holding is never charged and never pays; it is a key, not a purchase. Holders also vote on the app's build queue (capped per wallet at `VOTE_WALLET_CAP_BPS`, 2% of supply).

## Model-credit funding (the card that pays Anthropic)

The credits slice, tracked **per coin**, closes the loop between a coin's on-chain fees and its off-chain model bill. The card is the founder's Zentro card, set as Anthropic's billing method with auto-reload; Zentro has no API and rotates its deposit address per top-up, so the runner drives a logged-in Zentro session in headless Chromium (`ZENTRO_STATE`).

1. `feeSweep` records each fee's credits slice on that coin's `CREDITS:<appId>` ledger account (positive delta).
2. Every 5 minutes the `credits` worker reads each coin's `CREDITS:<appId>` balance. For every coin whose balance clears `MIN_CREDITS_FUNDING_USD` ($15) — capped at `MAX_CREDITS_FUNDING_USD` ($250) per top-up, the rest waits — it runs one `CreditFunding` through a persisted step machine, scoped to the coin so every top-up is attributable to the fees that paid for it:
   - `ADDRESS_MINTED` — the headless session walks Top Up → USDC (Ethereum) → amount → Continue and reads the fresh deposit address (`CreditFunding.wallet`). Nothing has left the treasury.
   - `SENT` — Relay (`api.relay.link`) quotes an `EXACT_OUTPUT` swap of treasury ETH on Robinhood Chain into exactly that many USDC on Ethereum mainnet delivered to the address, in one Robinhood-side transaction (fee ≈ $0.21 + gas). The quote is refused unless its output is worth ≥ 98% of the dollars requested, the recipient and asset match, and it is a single transaction. `relayRequestId`, `ethWei` (swap input + fees) and `usdcUnits` are written before the broadcast, `sendTx` with it, so a crash never sends twice: a later pass finds the row and resumes at the status poll (or adopts an intent Relay already saw).
   - `CONFIRMED` — `GET /intents/status` reports the fill; `fillTx` is the Ethereum transaction and a negative `CREDITS:<appId>` entry clears the coin's obligation in the same DB transaction. Relay usually fills within a minute; the sending pass waits up to 15 minutes and later passes keep polling.
   - `FAILED` — nothing moved (quote refused, deposit reverted, address stale after 30 minutes unsent) or Relay refunded/failed; the balance stays on the ledger for the next pass.
3. A `zentro_session_expired` (the stored session no longer authenticates) is recorded on the `credits_funding` PlatformSetting: `/ops` raises `ZENTRO_SESSION_EXPIRED` and funding backs off for 6 hours between attempts until the session is re-captured. With `ZENTRO_STATE` unset the setting says `accrue_only`, `/ops` shows `credits_accrue_only`, and the credits slice simply accrues.

Card numbers, CVV and the Zentro login never touch the platform; the captured session lives only in the `ZENTRO_STATE` secret, and deposit addresses appear in logs, audit rows and alerts masked (`0x1234…abcd`).

## $PYRE

$PYRE is the platform coin — itself a PONS v2 launch made from the treasury wallet (`PYRE_TOKEN`) on **Robinhood Chain, and only there**. It is not bridged, wrapped or relaunched on Solana or any other chain; any $PYRE on another chain is not us. Its only inflow is the 25% share of every Robinhood coin's creator fees, credited to the `PYRE_TOKEN` ledger account at each claim. That balance is periodically swapped into $PYRE and burned, and every burn is attested.

### Buyback + burn mechanics

1. The `PYRE_TOKEN` ledger balance accumulates from fee claims.
2. Every 10 minutes, when it reaches `MIN_BUYBACK_USD` ($5), the `buyback` worker opens a `PyreBurn` row for the whole balance, debits the ledger in the same transaction, and stores `attestHash = sha256(sorted ids of the fee-share ledger entries consumed)` and the ETH equivalent (`PyreBurn.ethWei`) at the current ETH price.
3. The treasury buys $PYRE with that ETH: pre-graduation `curve.buy(wei, minOut, treasury)`; after graduation a Universal Router v4 exact-in swap ETH → token to the treasury. `PyreBurn.swapTx`.
4. The received tokens are burned with `token.burn(amount)` — PONS v2 tokens are `ERC20Burnable`, so `totalSupply()` actually falls. `PyreBurn.burnTx`, `PyreBurn.burnedUnits`.
5. The treasury sends a zero-value transaction to itself whose calldata is `0x5059524501 || attestHash` — the bytes "PYRE", a version byte, and the attest hash. `PyreBurn.attestTx`. The burn ledger publishes the hash next to the three transactions so anyone can match it to the calldata on Blockscout and check the burn tx lowered `totalSupply`.
6. Burned supply shown on the site is read back from the chain (`totalSupply()` delta), not from the ledger; `reconcile` flags any drift between the two.

Robinhood coins are never bought back or burned by the platform: the only thing a Robinhood coin's fees do to supply is fund the $PYRE burn.

Burns are supply reductions executed by the platform on-chain. Nothing is paid to holders; see `docs/legal.md`.

### Other sinks and uses

- **Staking to an app** (`PyreStake`) — holders deposit $PYRE (18-decimal base units) against a specific app. Stakers get build priority for that app in the scheduler and a slice of that app's launcher-equivalent fee stream (`STAKERS:<appId>`), tracked in `PyreStake.earnedMicros` and paid in ETH on claim. Unstaking returns the deposit.
- **Governance weight** — platform proposals need ≥ `PLATFORM_PROPOSAL_MIN_HOLD_BPS` (3% of supply) to submit and reach quorum at `PLATFORM_PROPOSAL_QUORUM_BPS` (10%); votes are capped per wallet at `VOTE_WALLET_CAP_BPS` (2%). Prompt-queue voting on an app coin is capped the same way; submitting a task needs ≥ `PROMPT_QUEUE_MIN_HOLD_BPS` (0.1%) of the app coin.

Until `PYRE_TOKEN` is set the $PYRE page and governance are shown in their pre-launch state with no numbers, and the 25% share accrues on the ledger unswapped.

## Coin burns (Solana)

On Solana the 25% leg cannot reach $PYRE, so it burns the coin that earned it. The mechanics mirror the $PYRE burn one for one:

1. Each claim credits 25% to `COINBURN:<appId>`. Balances are per coin and never pooled: coin A's fees only ever buy and burn coin A.
2. Every 10 minutes, when a coin's `COINBURN:<appId>` balance reaches `MIN_BUYBACK_USD` ($5), the `buyback` worker opens a `CoinBurn` row for the whole balance, debits the ledger in the same transaction, and stores `attestHash = sha256(sorted ids of the fee-share ledger entries consumed)` (the same `attestationHash` digest as `PyreBurn`) and the SOL equivalent at the current SOL price.
3. The **treasury Solana wallet** buys the coin with that SOL: `buy_exact_sol_in` on the pump.fun curve before graduation, `buy_exact_quote_in` on the PumpSwap pool after. `CoinBurn.swapTx`.
4. The received tokens are burned with `burnChecked` on the Token-2022 mint — the mint has no mint authority, so `getTokenSupply` actually falls. `CoinBurn.burnTx`, `CoinBurn.burnedUnits`.
5. The treasury sends a transaction carrying one SPL Memo v2 instruction whose text is `pyre:burn:v1:<attestHash hex>`. `CoinBurn.attestTx`. The coin page's "coin burned" panel publishes the hash next to the three signatures so anyone can match it to the memo on Solscan and check the burn lowered supply.
6. Burned supply shown on the site is read back from the chain (`getTokenSupply` delta), not from the ledger; `reconcile` (`BURNS`) flags any drift for `CoinBurn` exactly as it does for `PyreBurn`.

`CoinBurn` walks `PENDING → SWAPPING → SWAPPED → BURNED` like `PyreBurn`, and `pauseBuyback` stops both legs. A Solana coin's burn is funded only by its own fee share — the platform never spends anything else on it, and never buys a Robinhood coin.

## Trading inside Pyre

Custodial users deposit the native asset to their Pyre address on that chain — ETH on Robinhood Chain (bridged from Arbitrum or Ethereum), SOL on Solana (SOL on Solana only; nothing else is credited) — buy and sell through server-signed transactions against the same curve or pool everyone else uses (PONS curve / Uniswap v4 on Robinhood Chain; pump.fun curve / PumpSwap on Solana, 1% default slippage, priority fee from the recent-fee median), and withdraw to any address on that chain (per-user daily cap `WITHDRAW_DAILY_CAP_USD`). External-wallet users sign in the browser on Robinhood Chain only; there is no browser-wallet trading on Solana, and the coin page offers "Trade on pump.fun" instead. Every coin page also links to the coin on PONS or pump.fun.

## Custodial wallets per chain

Every account has one custodial wallet per chain, both derived on the server from the same `PLATFORM_MASTER_SEED_HEX` and never exposed to the browser: `User.wallet` at BIP-32 `m/44'/60'/0'/0/<walletIndex>` (Robinhood Chain) and `User.solWallet` at SLIP-0010 ed25519 `m/44'/501'/<walletIndex>'/0'` (Solana). The treasury is `walletIndex` 0 on both. App wallets are `m/44'/60'/1'/0/<keypairIndex>` and `m/44'/501'/<1000000 + keypairIndex>'/0'`. Existing users get a Solana address the first time it is read; nothing about their Robinhood wallet changes.

**Launcher payouts** are paid on Robinhood Chain in ETH regardless of the coin's chain: the `LAUNCHER:<userId>` ledger is USD micros, and a claim converts at the ETH price at payout time from the Robinhood treasury, exactly as today. A Solana coin's launcher therefore claims ETH to their Robinhood wallet. One payout path, one treasury that pays people.

## Ledger

Every movement is one `LedgerEntry { account, deltaMicros, refType, refId, memo }`. Accounts: `TREASURY`, `PYRE_TOKEN`, `COINBURN:<appId>`, `CREDITS:<appId>`, `LAUNCHER:<userId>`, `BUILD:<appId>`, `STAKERS:<appId>`. `refType` is one of `FeeEvent`, `PyreBurn`, `CoinBurn`, `BuildJob`, `Payout`, `CreditFunding`. The burn ledger is `GET /v1/burns` ($PYRE); a Solana coin's burns are on its own page. Platform totals are `GET /v1/stats` and `GET /v1/pyre`.
