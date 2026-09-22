# Pyre economics

All constants live in `packages/shared/src/constants.ts`. Percentages are basis points (10 000 = 100%). Four units, never mixed: USD as micros (1 000 000 = $1), ETH as wei (10^18 = 1 ETH), coin balances as 18-decimal base units, USDG as 6-decimal units. JSON carries every bigint as a decimal string.

## Where a coin comes from

Every Pyre coin is a **PONS v2** launch on **Robinhood Chain** (chain id 4663). The launch is sent from the app's own derived wallet (`App.walletAddress`, HD path `m/44'/60'/1'/0/<index>`), so PONS records that wallet as the creator and as `creatorFeeRecipient`. The treasury pre-funds that wallet with the PONS launch fee (`PONS_LAUNCH_FEE_WEI`, 0.0005 ETH) plus gas. `creatorTaxBps` is 0 and PONS's own buyback flag is off: Pyre does its own buy-and-burn so every burn is attributable and attested.

The whole supply (`PONS_TOTAL_SUPPLY`, 1 000 000 000 tokens) is minted to a per-launch bonding curve. Buys and sells on the curve pay a 1% fee. When the curve has raised `PONS_GRADUATION_THRESHOLD_WEI` (**4.2 ETH**) it closes and liquidity moves into a **Uniswap v4** pool whose hook charges the same 1% on every swap. In both phases **70% of that 1% goes to the creator wallet** — the app — and the remaining 30% stays with PONS. There is no team allocation, no pre-mine and no launcher supply: every token is bought on the curve or in the pool like anyone else's.

## Two money streams per app

1. **Creator fees** — ETH. Fees accrue on the curve (`quoteFeeBalance`) or on the v4 hook (`pendingFees`); Pyre shows those as *accruing*. Every 5 minutes `feeSweep` sweeps them into the PONS **FeeEscrow** (`curve.sweepFees` pre-graduation, `hook.sweepPoolFees` after; when a post-graduation sweep needs an internal swap only the PONS operator may run it and Pyre waits) and then `escrow.claim()`s the balance to the app wallet. Each claim is a `FeeEvent { wei, ethPriceUsd }` priced in USD at claim time and split by `FEE_SPLIT_BPS`.
2. **App revenue** — USDG. Checkouts, subscriptions, per-request calls and internal ad impressions, all settled to the treasury. Split by `REVENUE_SPLIT_BPS`.

| Stream | Split | Destination |
| --- | --- | --- |
| Creator fees | 60% | Build cut: `BUILD:<appId>` (spendable budget) and `CREDITS:<appId>` (model-credit funding), 50/50 |
| | 25% | `PYRE_TOKEN` — $PYRE buyback + burn |
| | 15% | `LAUNCHER:<userId>` — the person who launched the coin |
| App revenue | 85% | Buyback + burn of the app's own coin |
| | 10% | `PYRE_TOKEN` — $PYRE buyback + burn |
| | 5% | `OPS` — platform operations |

Forks send `FORK_ROYALTY_BPS` (10%) of their creator fees upstream to the original app, forever, before the split above. Human contributors are paid through bounties (`Bounty`, ETH escrowed in the treasury and released on a merged PR), not through a fee-stream carve-out.

The 60% build cut is split by `CREDITS_FUNDING_BPS` (5000 = 50%) into the coin's spendable build budget (`BUILD:<appId>`) and a credits-funding slice (`CREDITS:<appId>`). Both are **per-coin**: a coin can only ever fund, and therefore spend, credits its own fees earned — a coin that earned $0 gets $0 of compute, and one coin's balance can never be spent by another.

## Worked example: $10 000 of trading volume

At a 1% trade fee with 70% to the creator, $10 000 of volume sends **$70.00** of ETH to the app wallet.

- Creator fee claimed: `FeeEvent.wei` worth **$70.00** at `ethPriceUsd` (from `getEthPriceUsd()`, DeFiLlama, cached 30 s)
- Build cut: 60% = **$42.00**, split 50/50 → spendable build budget **$21.00** (`App.budgetMicros += 21 000 000`) and credits funding **$21.00** (`CREDITS:<appId>` ledger)
- $PYRE buyback: 25% = $17.50
- Launcher: 15% = $10.50

The first build starts at `MIN_BUILD_BUDGET_USD` = $50 of accrued spendable budget, i.e. roughly **$24 000 of volume** at this rate. Iterations run whenever budget ≥ `ITERATION_BUDGET_USD.MIN` ($10), spend up to `DEFAULT` ($25) and never more than `MAX` ($50) per job. Budget is debited by the **actual** metered cost of the job (proxy usage × model price), not the cap.

Second example, revenue side: an app sells a $20 one-time product. `RevenueEvent.usdMicros = 20 000 000`; $17.00 is queued for buyback (`App.pendingRevenueMicros`), $2.00 goes to $PYRE, $1.00 to ops.

## Launch stake

Launching requires `LAUNCH_STAKE_WEI` (**0.002 ETH**, ≈$5). It is spam control, nothing else: it does not pay for the launch (the treasury does) and it is refunded in full to the launcher's wallet (`App.stakeRefundTx`) when the app first reaches the $50 build threshold, or immediately if the launch fails. Custodial users stake with one click from their Pyre balance; external-wallet users send 0.002 ETH to the treasury and submit the transaction hash, which the API verifies on-chain (`verifyEthTransfer`) before accepting it. A stake is not refunded for an app killed under the content policy.

## What the budget pays for

- Agent build jobs (metered through the Anthropic proxy per `JobToken`).
- `pyre.llm()` calls made by the app's server functions, at cost.
- Growth: LLM composition cost plus $0.05 per published X post, and ad tests of min($5, 5% of budget) once lifetime revenue passes $100.

Budget 0 with no revenue → `DORMANT`. The app is served as an "out of budget — buy to relight" page. Any new creator fee, or a direct top-up in ETH (`POST /v1/apps/:slug/topup`, 100% to budget), relights it. A global daily compute ceiling (`GLOBAL_DAILY_COMPUTE_CEILING_USD` = $2 000) caps platform-wide spend regardless of budgets.

## Buyback + burn mechanics

1. `pendingRevenueMicros` accumulates from verified revenue events.
2. Every 10 minutes, when it reaches `MIN_BUYBACK_USD` ($5), the `buyback` worker creates a `Buyback` row with `attestHash = sha256(revenue event ids)` and the ETH equivalent of the 85% share (`Buyback.ethWei`) at the current ETH price.
3. The treasury buys the coin with that ETH: pre-graduation `curve.buy(wei, minOut, treasury)`; after graduation a Universal Router v4 exact-in swap ETH → token to the treasury. `Buyback.swapTx`.
4. The received tokens are burned with `token.burn(amount)` — PONS v2 tokens are `ERC20Burnable`, so `totalSupply()` actually falls. `Buyback.burnTx`, `Buyback.burnedUnits`; `App.burnedTokens` and `App.buybackWei` increase.
5. The treasury sends a zero-value transaction to itself whose calldata is `0x5059524501 || sha256(revenueEventIds)` — the bytes "PYRE", a version byte, and the attest hash. `Buyback.attestTx`. Anyone can recompute the hash from the revenue event ids published on the coin page and check it on Blockscout.
6. 10% and 5% are recorded as `LedgerEntry` rows on `PYRE_TOKEN` and `OPS`.
7. Burned supply shown on the site is read back from the chain (`totalSupply()` delta), not from the ledger; `reconcile` flags any drift between the two.

Burns are supply reductions executed by the platform on-chain. Nothing is paid to holders; see `docs/legal.md`.

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

## App payments in USDG

Apps price in USD and settle 1:1 in **USDG** (Global Dollar, 6 decimals, `USDG_ADDRESS`). A custodial user never needs gas: the user's wallet signs an EIP-3009 `transferWithAuthorization` and the treasury relays it, paying the gas. External wallets pay with an ordinary transfer that the API verifies by receipt. Holder tiers read the coin's `balanceOf` for the wallet on the account.

## $PYRE

$PYRE is the platform coin — itself a PONS v2 launch made from the treasury wallet (`PYRE_TOKEN`). Inflows to its buyback account: 25% of every app's creator fees and 10% of every app's revenue. The `PYRE_TOKEN` balance is periodically swapped into $PYRE and burned exactly like an app coin, with the same attestation.

Sinks and uses:

- **Buyback + burn** — the `PYRE_TOKEN` balance is periodically swapped into $PYRE and burned.
- **Staking to an app** (`PyreStake`) — holders deposit $PYRE (18-decimal base units) against a specific app. Stakers get build priority for that app in the scheduler and a slice of that app's launcher-equivalent fee stream (`STAKERS:<appId>`), tracked in `PyreStake.earnedMicros` and paid in ETH on claim. Unstaking returns the deposit.
- **Governance weight** — platform proposals need ≥ `PLATFORM_PROPOSAL_MIN_HOLD_BPS` (3% of supply) to submit and reach quorum at `PLATFORM_PROPOSAL_QUORUM_BPS` (10%); votes are capped per wallet at `VOTE_WALLET_CAP_BPS` (2%). Prompt-queue voting on an app coin is capped the same way; submitting a task needs ≥ `PROMPT_QUEUE_MIN_HOLD_BPS` (0.1%) of the app coin.

Until `PYRE_TOKEN` is set the $PYRE page and governance are shown in their pre-launch state with no numbers.

## Trading inside Pyre

Custodial users deposit ETH to their Pyre address (bridged from Arbitrum or Ethereum), buy and sell through server-signed transactions against the same curve or pool everyone else uses, and withdraw to any address (per-user daily cap `WITHDRAW_DAILY_CAP_USD`). External-wallet users sign in the browser. Every coin page also links to the coin on PONS.

## Ledger

Every movement is one `LedgerEntry { account, deltaMicros, refType, refId, memo }`. Accounts: `TREASURY`, `PYRE_TOKEN`, `OPS`, `CREDITS:<appId>`, `LAUNCHER:<userId>`, `BUILD:<appId>`, `STAKERS:<appId>`. `refType` is one of `FeeEvent`, `RevenueEvent`, `Buyback`, `PyreBurn`, `BuildJob`, `Payout`, `CreditFunding`. The public ledger for an app is `GET /v1/apps/:slug/buybacks`; the global burn ledger is `GET /v1/burns`; platform totals are `GET /v1/stats` and `GET /v1/pyre`.
