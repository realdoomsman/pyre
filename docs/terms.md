# Terms of Service

_Last updated: 4 October 2026_

These terms are the agreement between you and Pyre ("Pyre", "the platform", "we"). They cover this website, the API, the launch tools, every app we host, the Pyre SDK, the coins launched through the platform on pump.fun, and the legacy coins launched through it earlier on PONS. Using any of it means you accept these terms. If you do not accept them, do not use Pyre.

## 1. What Pyre actually does

You submit an idea. A coin for that idea is launched through **pump.fun** on **Solana**. Before Pyre moved to Solana, 7 coins were launched through **PONS v2** on **Robinhood Chain**; launches there are closed, and those **legacy Robinhood Chain coins** keep running under these terms. The creator fees a coin earns are collected by the platform and split three ways: most is spent on an AI agent that writes, deploys, and maintains the app, a 25% share, and a share paid to the launcher. On a Solana coin the 25% share is used by the platform to buy that coin on the open market and burn it. On a legacy Robinhood Chain coin the 25% share funds the PYRE refunds in section 3 while anyone is still owed, and after that is used to buy $PYRE on the open market and burn it. The app itself is free to use.

**$PYRE is moving to Solana.** It relaunches as a new coin (`5H3MALVQ1swoJcyMyADfc7esbJomRLsKRyG8WjbG6fg5`) through a fair launch on **pump.fun**. The founder made a 2 SOL dev buy in the creation transaction, on the same curve and at the same price anyone else could, and locked all of those tokens on Streamflow until 4 October 2027 in a lock that cannot be cancelled or transferred ([public lock](https://app.streamflow.finance/contract/solana/mainnet/2iQK2icSJgpY8PQMqrDniRAZsS1M5NFgeFe7tnQkVpm8)). All of the coin's creator fees go to the platform treasury's Solana wallet. That mint is the only Solana $PYRE that is ours; any other "PYRE" on Solana or any other chain is not ours, and nothing on Pyre buys, burns or refers to it. $PYRE on Robinhood Chain (`0xc8488bE2e4f430420A364E64f4D8af428b74D903`) stays where it is, and the addresses that held it at the snapshot and still hold it are refunded as set out in section 3.

Pyre therefore does two things: it runs the build agent and it hosts the apps. It does not process payments inside apps, because there are none.

## 2. Who may use Pyre

You must be 18 or older and legally able to enter a contract. Do not use Pyre if you are a resident of, or located in, a place where launching, trading, or holding these tokens is unlawful, or if you are subject to sanctions. Complying with the law where you are is your responsibility, not ours.

## 3. Coins, buybacks, and burns — read this part

- Coins are created by third-party launch contracts and traded on third-party venues. On Solana: the **pump.fun** program, its bonding curve and, after graduation, a **PumpSwap** pool. For the legacy coins on Robinhood Chain: the **PONS v2** launch contracts, a PONS bonding curve and, after graduation, a **Uniswap v4** pool. pump.fun, PumpSwap, Solana, PONS, Uniswap and Robinhood Chain are third parties. Pyre does not issue the coins, does not set or support their price, and cannot reverse a trade.
- **A buyback is a burn, not a payment.** When the platform spends a coin's fee share on a buyback, it buys on the open market and destroys the tokens it receives: for a coin on Solana, the coin itself, by a token-program burn (a Solana coin's fees never buy $PYRE); for a legacy coin on Robinhood Chain, $PYRE, by calling the token's own `burn` function, once that coin's share is no longer funding PYRE refunds. Supply goes down. Nothing is sent to you. Legacy Robinhood Chain coins are not bought back by the platform at all; a Solana coin is bought back only with its own fee share. Buybacks are **not** distributions, dividends, interest, staking rewards, fee sharing, or yield, and no holder acquires a claim against Pyre, a launcher, or an app by holding a coin.
- We do not promise that buybacks will happen, continue, reach any size, or affect price. Burn history published on the site is a record of what happened, never a forecast.
- **PYRE refunds.** Each address that held $PYRE on Robinhood Chain at block **79819827** (4 October 2026, 09:12:28 UTC, before the move to Solana was announced) is owed the ETH it spent buying $PYRE minus the ETH it received selling $PYRE, from launch up to that block, capped at what it paid for the $PYRE it still held at that block, and never less than zero. $PYRE that only arrived by transfer was not paid for and earns nothing. $PYRE acquired after that block never counts. **To be refunded, you must still hold the PYRE you had at the snapshot. Selling or moving it after the snapshot shrinks your refund for good; buying more doesn't raise it.** Moving it to another wallet you own counts as moving. Your refund is scaled by the lowest $PYRE balance the address has held at any point since the snapshot, as recorded from Robinhood Chain transfers; an address whose balance has dropped to zero at any point since is no longer eligible and cannot link a payout wallet. Amounts already allocated to you before you sold or moved $PYRE stay payable. Refunds are funded only by **25% of the creator fees the Solana $PYRE coin earns** and **the 25% share of the legacy Robinhood Chain coins' creator fees**, both only while anyone is still owed; that pool is allocated pro-rata to what each address is still eligible for, converted at the ETH price at the time of each allocation, and paid in SOL to the Solana wallet the holder links at [/refund](/refund) by signing with both wallets (or, for a Pyre custodial wallet, with a signed-in session). A refund returns ETH that was put in and is capped at that amount. It is **not** a distribution, dividend, interest, yield, or a return on holding any coin, and holding $PYRE on either chain earns nothing from it. We do not promise when refunds are paid or that those coins will earn enough creator fees to repay anyone in full; payouts can be paused, for example during a security incident; refunds are only ever paid from this pool; and a refund paid to a wallet you linked cannot be reversed. The program ends when every address has been repaid what it is eligible for.
- **Creator fees are set by the venue, not by Pyre, and can change.** On pump.fun the creator fee is whatever pump.fun's fee program pays — at the time of writing 30 bps of bonding-curve trades and a market-cap-tiered share of PumpSwap trades — which pump.fun has changed before and may change again without notice to us or to you. pump.fun's own terms state that creator fees carry no warranty and that a coin's creator fees can be re-routed under its community-takeover ("CTO") process, in which case the app's fee stream may stop entirely. On PONS, for the legacy coins, the creator share is 70% of a 1% trade fee. Pyre does not control any of that, makes no promise that a coin will earn any fee on any venue, and owes nothing if a venue reduces, re-routes or ends creator fees.
- Holding a coin gets you whatever in-app features that app chooses to unlock for holders and a capped vote in its build queue. It is not equity, not a security in our view, not a profit share, and not a governance right over Pyre.
- Nothing on Pyre is investment, tax, or legal advice. Assume you can lose everything you spend on a coin.

## 4. Launching an app

- You put down a **refundable stake of 1 SOL**. It is a spam control, not a fee: the platform pays the coin-creation transaction itself. The stake is returned to your Pyre Solana wallet once the app reaches its first build threshold, or promptly if the launch fails. It is **not** returned if the app is killed for breaking these terms or the [Content Policy](/legal/content-policy). The legacy Robinhood Chain coins were staked with 0.05 ETH, which is returned in ETH on Robinhood Chain on the same terms.
- The coin is created on pump.fun from a Solana wallet the platform derives for the app, so that wallet — not you — is the creator of record on pump.fun and the recipient of creator fees (for a legacy coin, the app's Robinhood Chain wallet is the creator of record on PONS). You never hold that wallet's key.
- Your prompt, name, ticker, and image must comply with the Content Policy, must not infringe anyone's rights, and must not impersonate anyone. Coin details are written to the chain at creation and cannot be changed afterwards. On Solana the coin's metadata document is served by Pyre and is subject to these terms and the Content Policy.
- Launchers receive a share of their coin's creator fees for launching and specifying the app. That share is paid in the platform's accounting, in ETH on Robinhood Chain to the wallet on your account whatever chain your coin is on, and is published on the site; we may change it prospectively with notice.
- **Launchers receive no equity in Pyre and no allocation of any coin's supply.** There is no team allocation, no pre-mine, and no vesting grant. The entire supply is minted to the venue's bonding curve and is bought on the open market like anyone else's.
- One launch does not reserve a name, ticker, or idea. We may refuse, delay, or remove any launch. If pump.fun declines a launch, the launch fails and the stake is returned. New coins launch on pump.fun only; launches on PONS v2 are closed, and closing them did not affect the coins already launched there. We may disable a venue at any time; disabling one does not affect coins already launched on it.

## 5. Code, IP, and contributions

- Every app repository is public and licensed under the **MIT License**. By launching you agree that the code the agent generates is released under MIT.
- **No intellectual property is assigned to Pyre and none is assigned to you.** You keep whatever rights you already hold in your prompt and materials; Pyre keeps its rights in the platform, template, and SDK. You grant Pyre a perpetual, worldwide, royalty-free licence to use your prompt, spec, name, ticker, and image to build, host, and promote the app.
- Contributors who open pull requests contribute under the repository's MIT licence and may be paid bounties, escrowed in ETH and released on merge, as shown on the app page.
- Forking a Pyre app is allowed and sends a permanent royalty to the app you forked.

## 6. Apps are free; your wallets are custodial

- Every app hosted on Pyre is **free to use**. Apps do not sell anything, do not charge for features or calls, do not run subscriptions, and do not show ads. Pyre is not a merchant of record for anything, issues no receipts, and has no app purchases to refund.
- An app may unlock a feature for wallets that hold at least a stated amount of its coin. That is a product feature decided by reading your balance on chain. Holding is never charged and never pays out, and the app can change or remove the feature at any time.
- **Your Pyre wallets are custodial.** The Robinhood Chain wallet and the Solana wallet Pyre creates for you are held by the platform: Pyre holds their private keys and signs transactions on your behalf. You **authorise** on-chain actions; you never sign them in your browser and we never expose a private key to you. You can deposit to and withdraw from these wallets, subject to a daily withdrawal limit published on the site. Send only ETH on Robinhood Chain to your Robinhood address and only SOL on Solana to your Solana address; anything else sent to them is lost. If you instead sign in with your own wallet, you sign your own Robinhood Chain transactions and Pyre never holds a key for you — but **on Solana, Pyre is custodial only**: there is no Solana wallet sign-in, Solana coins are staked and traded from the custodial Solana wallet only, and if you want to trade a Solana coin with your own key you do it on pump.fun, outside Pyre. You are responsible for keeping your account credentials secure, and every blockchain transaction is irreversible once submitted.
- The only money you can move on Pyre is: buying and selling coins (section 7), the refundable launch stake (section 4), an optional ETH top-up to an app's build budget, and deposits to and withdrawals from your custodial wallets. If you held $PYRE at the snapshot and still hold it you can also link a Solana wallet to receive PYRE refunds (section 3); linking moves no money.

## 7. Trading inside Pyre

Pyre lets you buy and sell coins from the site against the same venue that everyone else uses: the pump.fun curve or PumpSwap pool on Solana, and for a legacy coin the PONS curve or Uniswap pool on Robinhood Chain. Quotes are estimates; the chain decides the final price, and your order can fail or fill worse than quoted within the slippage you set. Pyre charges nothing on top of the venue's own fee. We are not a broker, an exchange, or a market maker, and we do not hold coins for you beyond executing the order you asked for.

## 8. Build queue and holder features

Holders can submit tasks to an app's build queue and vote on them. Vote weight follows holdings and is capped per wallet so one wallet cannot own the roadmap. We may reject, reorder, or drop queue items, and the agent may simply fail to build something. This is a product feature, not a promise of delivery and not a legal right.

## 9. What you must not do

Do not: break the [Content Policy](/legal/content-policy); fake votes, holders, users, or fees; try to escape the function sandbox or the build sandbox; try to read other users' or other apps' data; extract platform secrets or API keys; reach networks we do not expose; scrape at abusive rates; interfere with other apps; or use Pyre to break the law.

## 10. Moderation, the kill switch, and takedowns

Pyre is moderated at three points and can be stopped at any of them.

1. **Launch classifier.** Every prompt, name, ticker, and image is screened automatically before an app exists. Rejected launches are never created.
2. **Reviewer gate.** Before any version goes live, an automated reviewer reads the change and blocks deploys that add wallet or auth code, ask users for money, load external scripts, open raw network access, or break the Content Policy.
3. **Kill switch.** We can kill any app at any time, with or without notice. Builds stop, the app stops serving, and its page shows that it was removed. We can also cancel a build, pause all builds, remove content, or ban an account.

Killing an app does not touch its coin: the coin lives in the pump.fun program on Solana (or, for a legacy coin, the PONS contracts on Robinhood Chain) and is outside our control. Report abuse, impersonation, or copyright infringement through the report link on any app page or the addresses in the [Content Policy](/legal/content-policy) — including **DMCA notices and counter-notices**, which we act on as described there.

## 11. No warranty

Pyre is provided **"as is" and "as available", with no warranty of any kind**, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.

Be specific about what this means here: the apps are written by an AI agent with minimal human review. They may contain bugs, broken logic, or security flaws. They may lose data, go offline, stop being maintained, or never be finished. We do not warrant that any app is fit for any purpose, that a build will start, that an app will keep working after it does, or that a coin will earn any fees on any venue. The PONS v2 contracts are third-party code that has not completed a public audit; the pump.fun and PumpSwap programs, their fee schedule and their community-takeover process are pump.fun's and can change without notice. Blockchain transactions are irreversible — check the address, the chain and the amount before you authorise it. We are not responsible for PONS, Uniswap, Robinhood Chain, pump.fun, PumpSwap, Solana, Google, Anthropic, GitHub, RPC, price and explorer providers, bridges, wallets, or any other third party.

## 12. Limitation of liability

To the fullest extent the law allows, Pyre and the people who operate it are not liable for indirect, incidental, special, consequential, exemplary, or punitive damages, nor for lost profits, lost tokens, lost income, or lost data. Our total liability for all claims is capped at the greater of **USD 100** or what you paid Pyre in the 12 months before the claim. Some jurisdictions do not allow these limits, in which case they apply as far as they can.

## 13. Indemnity

You will indemnify Pyre against claims, damages, and costs (including reasonable legal fees) arising from your launches, your prompts, your contributions, your use of an app, or your breach of these terms.

## 14. Governing law and disputes

**Not yet settled.** The governing law, the venue, and whether disputes go to arbitration or to court will be filled in on the advice of qualified counsel before Pyre operates at scale. Until this section names a jurisdiction, treat it as unresolved: nothing here waives any right you have under the mandatory consumer law of your own country, and no forum, class-action waiver, or arbitration clause is being asserted against you.

## 15. Changes, termination, and contact

We may change these terms; the date at the top changes with them and material changes are announced on the site. Continuing to use Pyre after a change accepts it. You may stop using Pyre at any time — on-chain records, public repositories, and ledger history remain. We may suspend or terminate access as set out in section 10.

Questions and legal notices go to the addresses published in the [Privacy Policy](/legal/privacy).
