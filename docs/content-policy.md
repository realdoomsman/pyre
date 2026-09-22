# Content Policy

_Last updated: 22 September 2026_

This policy covers everything that appears on Pyre: launch prompts, coin names, tickers and images, the apps the agent builds, build-queue tasks, pull requests, bounties, and the posts the platform makes about apps. It is enforced automatically at launch, automatically again before every deploy, and by people when something is reported.

## Not allowed

- **Scams and fraud.** Anything built to take money or tokens under false pretences: fake airdrops, "guaranteed returns", Ponzi or referral-chain schemes, rug mechanics, fake exchanges, bridges, or wallets.
- **Phishing and credential theft.** Apps that ask for a seed phrase, private key, or password, or that imitate a login screen or a wallet prompt. No Pyre app ever needs your seed phrase — sign-in is handled by the platform SDK.
- **Impersonation.** Using a real person's, company's, project's, or token's name, ticker, logo, or likeness in a way that implies affiliation or endorsement you do not have. That includes PONS, Robinhood, and Pyre itself. Parody has to be obvious.
- **Illegal content and activity.** Unlicensed gambling, sale of controlled goods, malware, doxxing, stalkerware, sanctions evasion, or anything else unlawful where we operate or where you are.
- **Gambling.** Games of chance for money or tokens, prediction markets, lotteries, and casino mechanics.
- **Adult content.** Pornography and sexually explicit material, generated or otherwise. Nothing sexualising minors, ever; that is reported to the authorities.
- **Hate and harassment.** Attacks on people based on race, ethnicity, national origin, religion, gender, sexuality, disability, or similar; targeted harassment; threats of violence.
- **Copyright and trademark infringement.** Do not launch apps built on media, characters, code, or brands you have no right to use. See **Reporting** below for DMCA.
- **Sandbox and platform abuse.** Trying to reach the network outside the SDK, load external scripts, keep secrets in the browser, break out of the build sandbox or the function runtime, read another app's or another user's data, or exhaust platform compute.
- **Asking users for money.** Apps are free. An app must not sell anything, charge for a feature or a call, run a subscription, show ads, or send users to an outside payment page. Holding the app's coin is the only thing an app may check.
- **Financial promises.** Apps, launch copy, and queue tasks must not promise price appreciation, yield, dividends, or profit from holding a coin. Buybacks on Pyre are **burns**, not returns, and must never be described as a payout, a distribution, or income.

## Allowed, with conditions

- **Holder-gated features** are fine when the perk is a product feature — extra tools, capacity, cosmetics — unlocked by holding the coin, and not a payout.
- **AI-generated content** is fine when the app is open about it and the output would not otherwise break this policy.
- **Forks** of Pyre apps are fine and pay a royalty upstream. Copying something from outside Pyre requires a licence that permits it.
- **Competitive and satirical apps** are fine, including ones about Pyre itself, as long as they do not impersonate or mislead.

## How enforcement actually works

1. **Prompt classifier — before the app exists.** Every prompt, name, ticker, and image is screened by an automated classifier at launch. A rejected launch is never created and you are told which category it failed. Borderline cases are held for human review.
2. **Reviewer gate — before every deploy.** An automated reviewer reads each change before it goes live and blocks anything that adds wallet or auth code, asks users for money, loads external scripts, opens raw network access, stores secrets in the browser, or violates this policy. A blocked deploy shows up in the app's public build feed.
3. **Reports — after it is live.** Anyone can report an app from its page or by email. Reports are read by people.
4. **Kill switch — at any time.** Depending on severity we reject the task or pull request, pause the app pending changes, or **kill** it: builds stop, the app stops serving, and its page shows that it was removed. Repeat or severe violations ban the account. Killing an app does not affect its coin, which lives in the PONS contracts on Robinhood Chain and is outside our control, and the launch stake is not refunded for an app killed under this policy.

Appeals: reply to the enforcement email you receive, or write to the abuse address below, with the app slug and what you think we got wrong. A human re-reads it.

## Reporting and takedowns

- **In the product:** use the report link on any coin page and pick Abuse, Impersonation, DMCA, or Other.
- **By email:** `report@pyre.fun` for abuse and impersonation, `dmca@pyre.fun` for copyright.

A **DMCA notice** must identify the copyrighted work, give the URL of the infringing app or repository, include your contact details, state a good-faith belief that the use is unauthorised, state under penalty of perjury that you are the owner or authorised to act for them, and be signed. We act on valid notices within one business day, remove or disable the material, and notify the launcher, who may file a **counter-notice** with the same formalities; if they do and the claimant does not sue, we may restore the material after 10 business days. Repeat infringers are banned. Filing a knowingly false notice or abusing the report system is itself a violation of this policy and may carry legal liability. Coin names, tickers, and images already written to the chain cannot be altered by anyone; we remove them from Pyre's pages and stop serving the app.

## Changes

New kinds of apps appear constantly and this policy will change with them. The date at the top changes when it does. The [Terms of Service](/legal/terms) explain the rest of the relationship; the [Privacy Policy](/legal/privacy) explains what we collect.
