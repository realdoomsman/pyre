# Legal posture

Internal notes on how the product is structured and why. This is not legal advice; have counsel review before launch and after any change to the money flows.

## Buybacks are not distributions

- 25% of every coin's creator fees funds on-chain purchases of $PYRE that are immediately burned (`token.burn`, so `totalSupply` falls). App coins are never bought back by the platform. No holder ever receives tokens or ETH from the platform because they hold a coin. There is no dividend, yield, claim, or redemption right.
- The platform executes the $PYRE buyback from its own treasury as a product feature; the amount, timing, and existence of buybacks are at the platform's discretion and can be paused (`PlatformSetting`, admin settings endpoint). Each buyback is attested on-chain (a zero-value treasury self-transaction carrying `0x5059524501 || sha256(fee-share ledger entry ids)`) so the record is verifiable without trusting the site.
- Public copy must not describe buybacks as returns, income, rewards, or "value accrual to holders". Approved language: "fees pay an agent to build the app; 25% of every coin's fees buys and burns PYRE". The growth worker's system prompt forbids price talk and the reviewer rejects it inside apps.
- Launcher payments (15% of creator fees) and bounty payouts (ETH escrowed in the treasury, released on a merged PR) are compensation for work: launching and specifying an app, and merged pull requests. There is no contributor carve-out of the fee stream. $PYRE staker slices are paid for providing scheduler priority to an app, not for holding.
- PONS's own creator-tax and holder-fee-sharing features are switched off for every Pyre launch (`creatorTaxBps = 0`, `buybackEnabled = false`), so the only fee that flows is the venue's base 1%, 70% of which lands in the app wallet.

## Custodial wallets and trading

- Custodial wallets are HD keys derived on the server (`m/44'/60'/0'/0/<index>`) from `PLATFORM_MASTER_SEED_HEX`. The browser never signs; every on-chain action for a custodial user is a server-signed transaction triggered by an authenticated request. External-wallet users sign their own transactions in the browser.
- The site executes buys and sells only against the same public PONS curve or Uniswap v4 pool everyone uses, at the user's request, with the user's slippage. Pyre takes no spread and no fee on trades. Copy says "trade", never "invest"; quotes are labelled estimates.
- Withdrawals are capped per user per day (`WITHDRAW_DAILY_CAP_USD`) as a blast-radius limit for a stolen session, and the cap is published in the terms and on the account page.
- Deleting an account retires the derived key; the account page tells users to withdraw first.

## Apps take no money

- Hosted apps are free to use. There is no checkout, subscription, per-request charge, purchase, or ad slot in any Pyre app, and `@pyre/app-sdk` exposes no way to ask a user for money. The platform is therefore not a merchant of record for anything, issues no receipts, and has nothing to refund.
- The only coin-linked feature inside an app is a holder tier: a feature that opens when the signed-in wallet holds at least N of the app's coin, decided by a `balanceOf` read. Holding is never charged and never pays out; it is a product feature, not a purchase or a return.
- The money a user can move on Pyre is limited to buying and selling coins on the public venue, staking the refundable launch stake, topping up an app's build budget in ETH, and depositing to or withdrawing from a custodial wallet. Every one of those is described in `docs/economics.md` and the terms.

## Code licensing

- Every generated repository is created public under the MIT license (`GITHUB_OWNER/pyre-<slug>`).
- No IP assignment: launchers keep whatever rights they have in their prompt and spec; the platform keeps rights in the template, SDK, and platform code; generated output is released under MIT to everyone. Contributors submit PRs under the repository's MIT license.
- The name, ticker, and image supplied at launch are the launcher's responsibility and are written immutably to the chain by the PONS launch. The impersonation category exists in the classifier and the report form; takedowns remove the coin from Pyre's pages and stop the app, they cannot alter the chain.

## Moderation and takedowns

- Intake: every prompt passes a classifier (`ModerationVerdict`: SCAM, PHISHING, GAMBLING, ILLEGAL, IMPERSONATION, ADULT, HATE, OTHER). Rejected prompts never become apps.
- Deploy: a reviewer model blocks diffs that add auth/wallet code, anything that asks users for money, external scripts, raw network access, exfiltration, or violate the content policy.
- Reports: `POST /v1/reports` (ABUSE, DMCA, IMPERSONATION, OTHER). Admins action reports and can kill an app (`KILLED` → 410, coin untouched).
- DMCA: designate an agent, publish the contact in `docs/privacy.md`/terms, follow the flow in `docs/runbook.md`. Counter-notices restore within the statutory window.

## Not legal advice

Nothing in the docs, the site, or the feed is legal, tax, or investment advice. Coins launched through PONS v2 on Robinhood Chain are third-party assets traded on third-party contracts (PONS, Uniswap v4) that have not completed a public audit; the platform custodies user funds only in the custodial wallets and treasury operations described in `docs/economics.md`. Users interact with Robinhood Chain at their own risk.
