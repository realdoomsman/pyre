# Legal posture

Internal notes on how the product is structured and why. This is not legal advice; have counsel review before launch and after any change to the money flows.

## Buybacks are not distributions

- 25% of every coin's creator fees funds on-chain purchases that are immediately burned. On Robinhood Chain that is $PYRE (`token.burn`, so `totalSupply` falls); on Solana, where $PYRE does not exist, it is the app's own coin (`burnChecked` on the Token-2022 mint, so `getTokenSupply` falls), funded only by that coin's own fee share. Robinhood app coins are never bought back by the platform. No holder ever receives tokens, ETH or SOL from the platform because they hold a coin. There is no dividend, yield, claim, or redemption right.
- The platform executes every buyback from its own treasury wallets as a product feature; the amount, timing, and existence of buybacks are at the platform's discretion and can be paused (`PlatformSetting`, admin settings endpoint). Each buyback is attested on-chain — a zero-value treasury self-transaction carrying `0x5059524501 || sha256(fee-share ledger entry ids)` on Robinhood Chain, an SPL Memo transaction from the treasury Solana wallet reading `pyre:burn:v1:<sha256>` on Solana — so the record is verifiable without trusting the site.
- Public copy must not describe buybacks as returns, income, rewards, or "value accrual to holders". Approved language: "fees pay an agent to build the app; 25% of every coin's fees buys and burns PYRE" on Robinhood Chain and "…buys and burns the coin" on Solana. The growth worker's system prompt forbids price talk and the reviewer rejects it inside apps.
- **$PYRE is one coin on Robinhood Chain.** It is not bridged, wrapped, mirrored or relaunched on Solana or anywhere else, and every public surface (README, terms, `/pyre` page, footer, posts) says so: any $PYRE on another chain is not us. Pyre never buys, references or lists a "PYRE" on Solana.
- Launcher payments (15% of creator fees) and bounty payouts (ETH escrowed in the treasury, released on a merged PR) are compensation for work: launching and specifying an app, and merged pull requests. Launcher payments are paid in ETH on Robinhood Chain whatever chain the coin is on. There is no contributor carve-out of the fee stream. $PYRE staker slices are paid for providing scheduler priority to an app, not for holding.
- PONS's own creator-tax and holder-fee-sharing features are switched off for every Pyre launch (`creatorTaxBps = 0`, `buybackEnabled = false`), so the only fee that flows is the venue's base 1%, 70% of which lands in the app wallet. On pump.fun the creator fee is pump.fun's: 30 bps of curve trades and a market-cap-tiered share of PumpSwap trades, set by pump.fun's fee program, changed by pump.fun before and changeable again, with no warranty under pump.fun's terms and subject to its community-takeover (CTO) process, which can re-route a coin's creator fees away from the app wallet. Pyre never launches with pump.fun's holder-reward, cashback or tokenized-agent options, so no pump.fun mechanism pays holders either. Copy and terms must not promise fee revenue on either venue.

## Custodial wallets and trading

- Custodial wallets are HD keys derived on the server from `PLATFORM_MASTER_SEED_HEX`: `m/44'/60'/0'/0/<index>` (secp256k1) on Robinhood Chain and `m/44'/501'/<index>'/0'` (SLIP-0010 ed25519) on Solana. The browser never signs; every on-chain action for a custodial user is a server-signed transaction triggered by an authenticated request. External-wallet users sign their own transactions in the browser on Robinhood Chain. **Solana is custodial-only**: there is no Solana wallet sign-in and no browser-wallet trading on Solana; a user who wants to trade a Solana coin with their own key is sent to pump.fun.
- The site executes buys and sells only against the same public venue everyone uses — PONS curve or Uniswap v4 pool on Robinhood Chain, pump.fun curve or PumpSwap pool on Solana — at the user's request, with the user's slippage. Pyre takes no spread and no fee on trades. Copy says "trade", never "invest"; quotes are labelled estimates.
- Withdrawals are capped per user per day (`WITHDRAW_DAILY_CAP_USD`) as a blast-radius limit for a stolen session, and the cap is published in the terms and on the account page.
- Deleting an account retires the derived key; the account page tells users to withdraw first.

## Apps take no money

- Hosted apps are free to use. There is no checkout, subscription, per-request charge, purchase, or ad slot in any Pyre app, and `@pyre/app-sdk` exposes no way to ask a user for money. The platform is therefore not a merchant of record for anything, issues no receipts, and has nothing to refund.
- The only coin-linked feature inside an app is a holder tier: a feature that opens when the signed-in wallet holds at least N of the app's coin, decided by a `balanceOf` read. Holding is never charged and never pays out; it is a product feature, not a purchase or a return.
- The money a user can move on Pyre is limited to buying and selling coins on the public venue, staking the refundable launch stake (0.05 ETH on Robinhood Chain, 1 SOL on Solana), topping up an app's build budget in ETH, and depositing to or withdrawing from a custodial wallet on either chain. Every one of those is described in `docs/economics.md` and the terms.

## Code licensing

- Every generated repository is created public under the MIT license (`GITHUB_OWNER/pyre-<slug>`).
- No IP assignment: launchers keep whatever rights they have in their prompt and spec; the platform keeps rights in the template, SDK, and platform code; generated output is released under MIT to everyone. Contributors submit PRs under the repository's MIT license.
- The name, ticker, and image supplied at launch are the launcher's responsibility and are written immutably to the chain by the PONS launch or the pump.fun `create_v2` (the metadata JSON that pump.fun reads is served by Pyre at `/v1/apps/:slug/metadata.json`; the on-chain name, symbol and URI are fixed at creation). The impersonation category exists in the classifier and the report form; takedowns remove the coin from Pyre's pages and stop the app, they cannot alter the chain.

## Moderation and takedowns

- Intake: every prompt passes a classifier (`ModerationVerdict`: SCAM, PHISHING, GAMBLING, ILLEGAL, IMPERSONATION, ADULT, HATE, OTHER). Rejected prompts never become apps.
- Deploy: a reviewer model blocks diffs that add auth/wallet code, anything that asks users for money, external scripts, raw network access, exfiltration, or violate the content policy.
- Reports: `POST /v1/reports` (ABUSE, DMCA, IMPERSONATION, OTHER). Admins action reports and can kill an app (`KILLED` → 410, coin untouched).
- DMCA: designate an agent, publish the contact in `docs/privacy.md`/terms, follow the flow in `docs/runbook.md`. Counter-notices restore within the statutory window.

## Not legal advice

Nothing in the docs, the site, or the feed is legal, tax, or investment advice. Coins launched through PONS v2 on Robinhood Chain and through pump.fun on Solana are third-party assets traded on third-party contracts and programs (PONS, Uniswap v4, pump.fun, PumpSwap) — the PONS contracts have not completed a public audit, and pump.fun's programs and fee rules are pump.fun's to change; the platform custodies user funds only in the custodial wallets and treasury operations described in `docs/economics.md`. Users interact with Robinhood Chain and Solana at their own risk.
