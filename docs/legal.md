# Legal posture

Internal notes on how the product is structured and why. This is not legal advice; have counsel review before launch and after any change to the money flows.

## Buybacks are not distributions

- App revenue funds on-chain purchases of the app's coin that are immediately burned (`token.burn`, so `totalSupply` falls). No holder ever receives tokens, ETH, or USDG from the platform because they hold the coin. There is no dividend, yield, claim, or redemption right.
- The platform executes buybacks from its own treasury as a product feature; the amount, timing, and existence of buybacks are at the platform's discretion and can be paused (`PlatformSetting`, admin settings endpoint). Each buyback is attested on-chain (a zero-value treasury self-transaction carrying `0x5059524501 || sha256(revenueEventIds)`) so the record is verifiable without trusting the site.
- Public copy must not describe buybacks as returns, income, rewards, or "value accrual to holders". Approved language: "revenue buys back and burns the coin". The growth worker's system prompt forbids price talk and the reviewer rejects it inside apps.
- Launcher (15%) and contributor (5%) payments are compensation for work: launching and specifying an app, and merged pull requests. $PYRE staker slices are paid for providing scheduler priority to an app, not for holding.
- PONS's own creator-tax and holder-fee-sharing features are switched off for every Pyre launch (`creatorTaxBps = 0`, `buybackEnabled = false`), so the only fee that flows is the venue's base 1%, 70% of which lands in the app wallet.

## Custodial wallets and trading

- Custodial wallets are HD keys derived on the server (`m/44'/60'/0'/0/<index>`) from `PLATFORM_MASTER_SEED_HEX`. The browser never signs; every on-chain action for a custodial user is a server-signed transaction triggered by an authenticated request. External-wallet users sign their own transactions in the browser.
- The site executes buys and sells only against the same public PONS curve or Uniswap v4 pool everyone uses, at the user's request, with the user's slippage. Pyre takes no spread and no fee on trades. Copy says "trade", never "invest"; quotes are labelled estimates.
- Withdrawals are capped per user per day (`WITHDRAW_DAILY_CAP_USD`) as a blast-radius limit for a stolen session, and the cap is published in the terms and on the account page.
- Deleting an account retires the derived key; the account page tells users to withdraw first.

## Merchant of record

- For USDG checkouts, subscriptions, and per-request calls the platform treasury is the payee and the merchant of record. The app launcher does not receive the funds; revenue is routed per `REVENUE_SPLIT_BPS`.
- Custodial users pay by signing an EIP-3009 `transferWithAuthorization` that the treasury relays (the treasury pays gas); external wallets pay by ordinary transfer verified by receipt. Either way the receipt is purchase id + transaction hash.
- Consequences: the platform issues receipts, handles refunds for broken deliveries, and is responsible for sales-tax/VAT determination where applicable. Keep a refund policy in the terms and a way to request one (reports endpoint, kind `OTHER`).
- Ads: internal only. Advertisers are other Pyre apps paying from their own build budget; no third-party advertiser accounts, no payouts to app operators.

## Code licensing

- Every generated repository is created public under the MIT license (`GITHUB_OWNER/pyre-<slug>`).
- No IP assignment: launchers keep whatever rights they have in their prompt and spec; the platform keeps rights in the template, SDK, and platform code; generated output is released under MIT to everyone. Contributors submit PRs under the repository's MIT license.
- The name, ticker, and image supplied at launch are the launcher's responsibility and are written immutably to the chain by the PONS launch. The impersonation category exists in the classifier and the report form; takedowns remove the coin from Pyre's pages and stop the app, they cannot alter the chain.

## Moderation and takedowns

- Intake: every prompt passes a classifier (`ModerationVerdict`: SCAM, PHISHING, GAMBLING, ILLEGAL, IMPERSONATION, ADULT, HATE, OTHER). Rejected prompts never become apps.
- Deploy: a reviewer model blocks diffs that add auth/wallet/payment code, external scripts, raw network access, exfiltration, or violate the content policy.
- Reports: `POST /v1/reports` (ABUSE, DMCA, IMPERSONATION, OTHER). Admins action reports and can kill an app (`KILLED` → 410, coin untouched).
- DMCA: designate an agent, publish the contact in `docs/privacy.md`/terms, follow the flow in `docs/runbook.md`. Counter-notices restore within the statutory window.

## Not legal advice

Nothing in the docs, the site, or the feed is legal, tax, or investment advice. Coins launched through PONS v2 on Robinhood Chain are third-party assets traded on third-party contracts (PONS, Uniswap v4) that have not completed a public audit; the platform custodies user funds only in the custodial wallets and treasury operations described in `docs/economics.md`. Users interact with Robinhood Chain at their own risk.
