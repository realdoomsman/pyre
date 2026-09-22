# Privacy Policy

_Last updated: 22 September 2026_

This policy explains what Pyre collects, why we collect it, who else sees it, and how long we keep it. It covers this website, the API, and every app hosted on a Pyre domain or path. Apps built on Pyre use our login and our storage, so this one policy applies inside them too — an app cannot collect more than what is listed here, because the SDK is the only way it can store or read anything.

## What we collect

- **Account identifiers from Google Sign-In.** We use Google Sign-In to log you in. We receive your Google account id, email address, name, and avatar. If you sign in with a wallet instead, we receive the wallet address and a one-time signed message that proves you control it. **We never receive your Google password, private keys, or seed phrase.**
- **Your custodial Pyre wallets.** When you sign in, Pyre derives and holds a Robinhood Chain wallet and a Solana wallet on your behalf and signs every on-chain transaction for you; you can deposit to them and withdraw from them. These are **custodial wallets** — we custody their private keys on our servers and never expose a private key to your browser, but we do hold them. If you instead connect your own external wallet, you keep sole control of that wallet's keys and sign your own Robinhood Chain transactions; there is no external-wallet option on Solana.
- **Wallet addresses and on-chain data.** Public addresses, coin balances for Pyre coins, and transaction hashes or signatures. This data is already public on Robinhood Chain or Solana; we index it to compute holder tiers, vote weight, staking positions, and to verify that a stake, a top-up, or a deposit actually happened.
- **What you submit when launching.** Your prompt, the generated spec, the app name, ticker, image, and the venue you chose. Prompts go to an AI model for moderation and spec generation and end up in the app's public repository, so treat them as public. The name, ticker, and image are written to the chain at launch and cannot be removed from it; for a Solana coin the metadata document pump.fun reads (name, ticker, description, image, website) is served publicly by Pyre.
- **App usage counters.** Inside a hosted app we record the app id, your user id, a first-seen and last-seen timestamp, and the key-value data the app stores for you through `pyre.kv`. Counters are how the app store shows user numbers. An app can read only the values it wrote for you; it cannot read another user's values or another app's data.
- **Technical logs.** IP address, user agent, and request metadata, used for security, abuse detection, and rate limiting.
- **Reports and correspondence.** What you send us when you report an app or email us, including the contact details you provide.

We do **not** collect card numbers, bank details, government identifiers, biometrics, or precise location. We do not run third-party analytics or advertising trackers, and there are no ads inside apps.

## Why we use it

- **To run the platform:** sign you in, host apps, verify stakes and top-ups, execute the trades and withdrawals you ask for, apply holder features, count votes, and track staking.
- **To build apps:** your prompt, your queue tasks, and votes are inputs to the automated build agent.
- **To keep it safe:** moderation of launches, the pre-deploy reviewer, abuse detection, rate limiting, withdrawal limits, and legal compliance.
- **To show public activity:** the feed, the app store, build feeds, burn ledgers, contributor lists, staking tables, and holder lists display wallet addresses, X handles, and amounts. All of it is either already public on-chain or was submitted to be published.

We do not sell personal data, and we do not use it to train models of our own.

## Who else sees it

- **Google** — authentication (sign-in).
- **Anthropic** — AI models. Prompts, specs, build context, and inputs to app functions that call `pyre.llm` are processed by Anthropic under its API terms. Do not put secrets or sensitive personal data into a prompt or an app input.
- **E2B** — build sandboxes. They receive app source code, not user data.
- **GitHub** — hosts every app's public repository.
- **Robinhood Chain and Solana RPC providers, Blockscout and Solscan** — on-chain reads, transaction broadcasts, and holder and transaction lookups. Your browser talks to Robinhood Chain only through Pyre's read-only RPC proxy and never talks to a Solana RPC at all, so no public RPC sees your IP address directly.
- **PONS, Uniswap, pump.fun and PumpSwap** — the launch, curve, and pool contracts and programs your trades interact with. Contracts see wallet addresses and amounts, as any chain interaction does. pump.fun also fetches a Solana coin's public metadata document from Pyre.
- **Jupiter, CoinGecko and DeFiLlama** — price oracles for SOL and ETH; they receive no user data.
- **X (Twitter)** — only when the platform posts about an app; posts contain public app information only.
- **Railway** — hosting for the site, the API, and the runner.
- **Authorities and claimants** — when the law requires it, for example a valid DMCA notice, subpoena, or court order.

## Cookies and local storage

The website keeps you signed in with a session token stored in your browser (localStorage). Each hosted app sets exactly one signed session cookie, `pyre_app_session`, scoped to that app's own path or subdomain so one app's session can never be replayed at another. There are no analytics or advertising cookies anywhere on Pyre.

## How long we keep it

- **Account, launch, ledger, staking, and build history:** for as long as Pyre operates. These records document money movements and public build history, so they are not deleted on request.
- **Technical logs (IP, user agent, request metadata):** 30 days, then deleted.
- **App key-value data:** until you delete it through the app, the app is deleted, or your account is deleted.
- **Reports and correspondence:** 2 years after the matter is closed.
- **Killed apps:** the app stops serving immediately; its record and history stay in the database for audit and appeals.

## Your choices and rights

Depending on where you live you may have the right to access, correct, export, or delete your personal data, or to object to some processing. Email the privacy address below from the account concerned and we will answer within 30 days.

Two honest limits: we cannot delete anything recorded on Robinhood Chain or Solana or published in a public GitHub repository, because none of it is ours to erase, and we keep the ledger records we are required to keep. Deleting your account unlinks your identifiers from future activity; it does not rewrite a chain or the public build feed. Before deleting your account, withdraw any balance from your custodial wallets — their keys are derived from your account and are retired with it.

## Security

Session tokens are signed, app functions run in a memory- and time-limited sandbox with no network access beyond the platform API, custodial keys are derived on the server from a master seed that never leaves it, and platform keys are never exposed to app code or to the browser. Withdrawals are capped per user per day to limit the damage of a stolen session. No system is perfect: if we discover a breach affecting your data we will tell affected users and, where required, regulators.

## Children

Pyre is not for anyone under 18 and we do not knowingly collect data from children.

## Changes

The date at the top changes when this policy changes, and material changes are announced on the site.

## Contact

- Privacy and data requests: **privacy@pyre.fun**
- Abuse, impersonation, and general reports: **report@pyre.fun**, or the report form on any app page
- Copyright (DMCA) notices: **dmca@pyre.fun**
