# coins that build apps. revenue burns them.

*How Pyre turns a one-sentence idea into a launched coin, a funded AI build, a paying app and a verifiable burn, on Robinhood Chain, with the numbers, the addresses and the parts that are not finished yet.*

---

Pyre is a launchpad with a job attached. Every coin on it is a pons v2 launch on Robinhood Chain, and every coin describes an app. The coin's trading fees pay an AI agent to build that app. The app charges its users in dollars. Those dollars buy the coin back and burn it, and each burn is attested on chain in a way anyone can recompute.

The site is live at [pyre.fun](https://pyre.fun), the API at [api.pyre.fun](https://api.pyre.fun), and the code is public under MIT at [github.com/realdoomsman/pyre](https://github.com/realdoomsman/pyre). This is the long version: what it does, why it is built this way, and what is still blocked.

## the problem, in three parts

Launchpad coins have nothing behind them. A coin launches, a curve fills, a pool opens, and from then on the only thing that can move the supply is more trading. There is no product, no revenue, no mechanism by which the outside world can push value in. What happens next is decided by who sells first.

App builders cannot fund themselves. A small useful tool, a pay-per-call API, a crawler that emails you once a week, is worth a few dollars to its users but not worth a fundraise. There is no capital for the first fifty dollars of work, so the work does not happen.

Buybacks are usually theatre. "We buy back" means a wallet bought some coins. It rarely means the supply fell, it almost never says which revenue paid for it, and neither claim can be checked without trusting the team.

Pyre is an attempt to close all three at once with one loop, and to make each step of that loop a transaction you can open on an explorer.

## the loop

![The Pyre loop: launch, fees, build, ship, earn, burn, with a return arc showing that any new fee relights a dormant app](figures/01-loop.png)

**Launch.** You write one sentence: what the app does. An intake agent turns it into a spec with four fields: what it does, who pays, the MVP, the price. You edit or approve it. You stake 0.002 ETH; the stake is spam control, refunded in full when the app first reaches its build threshold, or immediately if the launch fails. The coin is launched on pons v2 from the app's own derived wallet, so pons records that wallet as creator and fee recipient. There is no team allocation, no pre-mine and no launcher supply. Every coin is bought on the curve or in the pool like anyone else's.

**Fees.** pons v2 charges 1% on every trade, on the bonding curve and, after graduation, in the Uniswap v4 pool. 70% of that 1% goes to the creator wallet, which is the app. Pyre pull-claims it from the pons FeeEscrow every five minutes and splits it three ways: 60% to the build, 25% to a PYRE buyback, 15% to the person who launched the coin.

**Build.** When the spendable build budget reaches $50, the scheduler starts the first build. An E2B microVM boots from a fixed template and runs the Claude Agent SDK against the spec. The agent can write product code. It cannot write auth, wallet or payment code; those come from `@pyre/app-sdk` and are hard-blocked at review.

**Ship.** The output has to pass `npm run build`, a Playwright smoke test, screenshots, Lighthouse, and then a reviewer agent that reads the diff and the manifest and rejects anything touching money, making raw network calls or drifting from the spec. Only then does it deploy to `<slug>.pyre.fun`. Every tool call the agent makes is published to the coin page as it happens.

**Earn.** The app charges in USDG, the Robinhood Chain stablecoin. A custodial user signs an EIP-3009 `transferWithAuthorization`; the treasury relays it and pays the gas, so users never need ETH. Charges are capped at $250 each and $1,000 per user, per app, per day. Each verified payment becomes a revenue event with an id.

**Burn.** Every ten minutes, if at least $5 of revenue is pending, the treasury buys the coin with 85% of it, on the curve before graduation or through Uniswap v4 after, and calls `burn()`. pons v2 coins are `ERC20Burnable`, so `totalSupply()` actually falls; Pyre reads the supply before and after and stores the difference. Then it sends the attestation transaction described below. The remaining 15% is 10% to a PYRE buyback and 5% to operations.

If the build budget hits $0 and there is no revenue, the app goes dormant. Pyre calls this "ash". The page is still served, and any new fee, from a single trade, relights it.

The front page ranks coins by dollars earned, not by trading volume. The app is the point; the coin is the consequence.

## where the money goes

![Money-flow diagram: trading fees split 70% to the app then 60/25/15; app revenue split 85/10/5](figures/02-money.png)

The two inflows never mix. Trading fees fund the build. App revenue funds the burn. Pyre takes nothing from trades at all; its only cut is 5% of app revenue, for operations.

A worked example from the repo's economics doc: $10,000 of trading volume sends $70 of ETH to the app wallet. $42 goes to the build cut (half as spendable budget, half funding the model credits that pay for the agent's compute), $17.50 to the PYRE buyback, $10.50 to the launcher. At that rate the first build starts after roughly $24,000 of volume. On the revenue side, an app that sells a $20 product queues $17 for its own buyback, $2 for PYRE and $1 for ops. Each build job spends up to $25 by default and never more than $50, debited by the job's actual metered cost, not the cap.

## why robinhood chain and pons v2

Robinhood Chain is an Arbitrum Nitro L2 (chain id 4663) with roughly 0.1-second blocks and ETH gas. The loop makes a lot of small transactions: a fee claim every five minutes, a buyback every ten, a burn and an attestation for each, a gasless USDG relay for every app payment. It needs a chain where that is cheap and fast and where there is a dollar stablecoin to charge in. USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` is that stablecoin.

pons v2 supplies three things Pyre needed and did not want to write. A bonding curve that graduates: the full supply is minted to a per-launch curve, and when it has raised 4.2 ETH the curve closes and liquidity moves into a Uniswap v4 pool whose position is held permanently by the pons launch locker (the pons docs describe it as locked, with no unlock path) and whose hook charges the same 1% on every swap. A pull-based FeeEscrow, so creator fees sit in a contract until claimed, and each claim is a public `Claimed` event Pyre reconciles against its own ledger. And coins that are `ERC20Burnable`, so a burn is a real supply reduction, not a transfer to a dead address. Pyre launches with `creatorTaxBps` at 0 and pons's own buyback flag off, because it does its own buy-and-burn so that every burn is attributable and attested. Pyre is a user of pons and of Robinhood Chain, not a partner of either.

## what the agent builds, and what it cannot touch

![Architecture: web and api share postgres and redis; a runner with thirteen BullMQ queues drives builds, chain workers and a five-minute reconcile pass](figures/04-architecture.png)

Generated apps start from a fixed template whose lint rules ban `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `localStorage`, `eval`, script injection and `dangerouslySetInnerHTML`. Sign-in, wallet access and payments are imported from `@pyre/app-sdk`, never written by the model. Each app is served from its own subdomain under a strict CSP with no outbound network, its own HMAC-signed session cookie and origin checks on every mutating request, so apps cannot read each other's storage or sessions. Server-side logic runs in QuickJS: 64 MB of memory, a 5-second CPU deadline, no imports, no network except other Pyre functions.

The build sandbox never holds a real API key. It sees a per-job credential against an Anthropic proxy that allowlists models, meters usage, returns 402 when that job's budget is exhausted and 429 when the platform's daily ceiling is, and is revoked when the job ends. Behind all of it, a reconcile worker runs every five minutes across seven checks, JOBS, SANDBOXES, JOBTOKENS, LEDGER, FEES, BURNS and PAYOUTS: settling builds whose runner died, killing sandboxes with no live job, replaying missed fee claims into the ledger, and reporting, never auto-correcting, anything that touches money.

## the attestation

![Attestation calldata layout: 0x, four magic bytes 50 59 52 45, version byte 01, then a 32-byte sha256 of the sorted, comma-joined revenue-event ids, with a worked example](figures/03-attestation.png)

This is the part that makes "buyback" a checkable claim. After the burn transaction confirms, the treasury sends a zero-value transaction to itself. The calldata is 37 bytes:

```
0x 50595245 01 <32-byte sha256>
   ^^^^^^^^ ^^ ^^^^^^^^^^^^^^^^
   "PYRE"   v1 sha256(sorted revenue-event ids, joined by ",")
```

The hash is over the ids of the revenue events the buyback consumed, sorted and comma-joined, so it is order-independent, and any change to the set (an id added, removed or duplicated) changes it. Worked example, using the values pinned in the repo's tests: the ids `["rev_c", "rev_a", "rev_b"]` sort to `rev_a,rev_b,rev_c`, whose sha256 is `78e9b6e5df154dc1d9d8820d76252ceeae39628b5011226b55e8dd76f8544723`. The calldata on chain is therefore:

```
0x505952450178e9b6e5df154dc1d9d8820d76252ceeae39628b5011226b55e8dd76f8544723
```

The burn ledger publishes, for every buyback, the revenue-event ids, the swap tx, the burn tx and the attestation tx. To verify one: take the ids from the ledger row, sort, join, hash, prepend `0x5059524501`, and compare with the calldata of the attestation tx on Blockscout. Then open the burn tx and confirm `totalSupply` fell by the amount the row claims. No part of that requires trusting Pyre.

## the numbers

![Economics card: the trade-fee split, the revenue split and every threshold the loop runs on](figures/05-economics.png)

| item | value |
|---|---|
| trade fee (pons v2, curve and pool) | 1% |
| of that, to the creator wallet (the app) | 70% |
| app's share → build / PYRE buyback / launcher | 60% / 25% / 15% |
| fee claim cadence | every 5 min |
| app revenue → coin buyback and burn / PYRE buyback / ops | 85% / 10% / 5% |
| buyback cadence, minimum pending | every 10 min, $5 |
| per-charge cap, per user per app per day | $250, $1,000 |
| launch stake (refundable) | 0.002 ETH |
| first build starts at | $50 spendable budget |
| graduation from curve to Uniswap v4 | 4.2 ETH |
| dormant at | $0 budget; relit by any new fee |
| server functions | QuickJS, 64 MB, 5 s |
| reconcile pass | every 5 min |

All of these are constants in `packages/shared` of the public repo. Only what an app charges is set per coin, in its spec.

## security posture, and what an independent review found

Browsers never hold a private key. Custodial users and apps are BIP-32 children of one platform seed on separate branches (`m/44'/60'`), derived in server memory only. External wallets sign in with an EIP-191 challenge with a single-use nonce. Every send from the treasury or an app wallet goes through one function that holds a Redis mutex from broadcast to receipt, and the treasury fails closed rather than drop below its floor.

Nothing trusts a client-reported amount. USDG payments, external stakes and top-ups are verified by receipt before anything is recorded, and a transaction hash can only ever settle one launch. The public `/v1/rpc` endpoint forwards an allowlist of read methods only, no batches, rate-limited per IP. Rate limits are Redis sliding windows per bucket; the auth, payout, proposal and proxy buckets fail closed if Redis is down.

An independent security review of the codebase found one High and five Medium issues. The High was a treasury-drain path: stake settlement accepted an arbitrary transaction hash as proof of stake, so any inbound treasury transaction, a fee sweep, an escrow claim, could be presented as a stake and refunded to the caller. It is fixed: a stake tx must be mined and successful, sent to the treasury, of at least the stake value, from the launcher's proven wallet and not from a platform wallet, and each hash can be used once. The five Mediums are fixed as well.

## engineering proof

![Audit card: 62 of 68 production features pass, 6 blocked on treasury funding; 408 unit tests; 1 high and 5 medium review findings fixed](figures/06-audit.png)

The unit suite is 408 tests across the API, runner, web, chain and shared packages, with no network, database, Redis, RPC or model access, so it runs in CI on every push.

The production feature audit exercises the deployed system end to end: real HTTP against the public origin, a throwaway wallet signing the SIWE-style challenge, the rate limiter, auth and routes running unmodified. Of 68 features, 62 pass. The other 6 are blocked on treasury funding and nothing else: each reaches its funding gate and refuses cleanly.

The perimeter security check covers CSRF on app endpoints, CSP and cookie flags, CORS, webhook HMAC, the RPC proxy, wallet auth, the model proxy and rate limits. Every check that can run without a hosted app passes; the app-origin checks run again the moment the first app deploys.

## what is live today, and what launches next

Everything above is deployed: the web app, the API, the runner with all thirteen queues, the E2B build template, custodial wallets, USDG charges, the burn ledger and the reconcile pass, all against Robinhood Chain mainnet.

Two things are not yet true. The treasury at `0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54` is unfunded, which is why the six on-chain audit checks are blocked and why no real coin has been through the loop yet. And PYRE has not launched. Until it does, the 25% and 10% PYRE slices accrue on the ledger and the PYRE page shows its pre-launch state. It is launching soon; there is no contract address until it exists, and anyone offering one is not us.

The site shows zeros today: no apps, no revenue, no burns. The demo rows used to build and verify the platform have been removed, and no figure appears on pyre.fun until a real coin earns it.

What launches next, in order: treasury funding, an on-chain dry run of the full loop with a throwaway coin (launch, sweep, buy, burn, attest, with the hashes published), PYRE, then the first coins.

## how to launch

![The launch page on pyre.fun: name the coin, describe the app in one sentence, stake 0.002 ETH](figures/09-launch.png)

1. Sign in at [pyre.fun/launch](https://pyre.fun/launch). Google sign-in gives you a custodial Pyre wallet on Robinhood Chain; or sign in with your own wallet.
2. Name the coin and write one sentence describing the app.
3. Read the spec the intake agent produces: what it does, who pays, the MVP, the price. Edit it or approve it.
4. Stake 0.002 ETH, one click from a custodial balance, or send it to the treasury from your own wallet and submit the hash.
5. The coin launches on pons v2 from the app's own wallet. From then on the loop runs itself: fees are claimed, the build starts at $50, the app deploys when it passes review, and revenue burns the coin. You can read every tool call on the coin's build tab, queue tasks as a holder, and see every burn with its attestation on the burn tab.

## verify it yourself

| what | where |
|---|---|
| Robinhood Chain | chain id 4663, RPC `https://rpc.mainnet.chain.robinhood.com` |
| explorer | [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com) |
| pons v2 factory | [`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`](https://robinhoodchain.blockscout.com/address/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e) |
| pons FeeEscrow | [`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`](https://robinhoodchain.blockscout.com/address/0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e) |
| USDG | [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/token/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) |
| Pyre treasury | [`0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54`](https://robinhoodchain.blockscout.com/address/0x0D01debaF26A513c55D8aa7B5Ac6299040a37f54) (currently unfunded) |
| burn ledger | [pyre.fun/burns](https://pyre.fun/burns), `GET https://api.pyre.fun/v1/burns` |
| platform totals | `GET https://api.pyre.fun/v1/stats` |
| attestation encoding | `packages/chain/src/burn.ts` in the repo; `ATTESTATION_PREFIX = 0x5059524501` |
| source | [github.com/realdoomsman/pyre](https://github.com/realdoomsman/pyre), MIT |

Every burn attestation is a treasury self-transaction whose calldata starts `0x5059524501`. Once the treasury is funded, that prefix on Blockscout lists every burn Pyre has ever made.

## faq

**Does Pyre pay anything to holders?** No. Buybacks are burns. Nothing is distributed or shared. Supply falls; that is the whole mechanism.

**Who owns the app?** Each app has a public GitHub repo. Contributors can open pull requests, which go through the same reviewer gate, and bounties for merged work are escrowed in the treasury in ETH.

**What if the agent builds something bad?** It cannot deploy without passing build, smoke tests and a reviewer that blocks money-touching code, external scripts, raw network calls and spec drift. Apps run under a CSP with no outbound network, and server functions can only reach other Pyre functions. There is a public report endpoint and an admin kill switch that replaces the app with a 410.

**What if nobody uses the app?** Then there is no revenue and no burn. When the build budget reaches $0 the app goes dormant. Any new trade fee relights it. Coins whose apps never earn will show that on the front page, because the front page ranks by dollars earned.

**Is this financial advice?** No. Coins are not investments. Apps can fail. Market cap is a fact the site displays, never a claim it makes.

## risks, plainly

The treasury is unfunded and no coin has completed the loop on mainnet. Everything on-chain in this article has been exercised in tests and against the deployed API, not yet with real ETH. The six blocked audit checks are exactly that gap.

Apps can fail to earn. Most small apps do. A coin whose app earns nothing has no buyback and goes dormant; the mechanism does not create demand, it only routes it.

The agent can produce mediocre software. The reviewer gate stops it shipping dangerous or off-spec code; it does not make the code good. Budgets are small by design.

Pyre depends on third parties it does not control: pons v2 contracts, Robinhood Chain, Uniswap v4, E2B, Anthropic. A change or outage at any of them stops the loop until it is handled.

Custodial wallets are custodial, derived from one platform seed. If you would rather hold your own key, sign in with an external wallet and pay from it.

Every number on pyre.fun is zero until a real coin earns it. Nothing there is seeded, sampled or projected.

Not financial advice.

---

*Pyre · [pyre.fun](https://pyre.fun) · [@PyreFun](https://x.com/PyreFun) · [github.com/realdoomsman/pyre](https://github.com/realdoomsman/pyre) · Robinhood Chain 4663*
