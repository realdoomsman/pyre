# Berth — X launch posts

20 standalone tweets, one per theme. Each is <=280 characters. No emojis, no hashtags, no price hype.

### 1. Thesis: coins that build apps
- image: cap/el/card-coin.png
```
coins that build apps.

you write one sentence. a coin launches on pump.fun. 60% of its trading fees pay an agent to design, build, deploy and keep shipping a real app. every coin funds and owns a real piece of software.
```
- chars: 220

### 2. The full loop (one sentence -> coin -> app -> burn)
- image: posts/loop.png
```
the loop:

one sentence -> a spec you approve -> a coin on pump.fun -> fees fund an agent that builds the app -> the app charges users -> 85% of that revenue buys the coin back and burns it.

supply falls. nobody gets a distribution.
```
- chars: 233

### 3. Ranked by dollars the app earned, not volume
- image: posts/framed/board.png
```
the front page ranks coins by the dollars their product actually earned. not volume, not market cap.

a leaderboard for revenue, not hype.
```
- chars: 138

### 4. You write one sentence; an agent writes the spec, builds, deploys, keeps shipping
- image: posts/framed/launch.png
```
you write one sentence.

it gets moderated and turned into a concrete spec you approve. an agent builds it, passes the gates, deploys it, and keeps iterating. you never touch the code.

berth.fun
```
- chars: 195

### 5. The entire build is public and streams live
- image: posts/framed/buildlog.png
```
the whole build is public and streams live.

the agent works in a sandbox, the log feeds to the coin page in real time, and every generated file ships MIT. you watch the app get built line by line.
```
- chars: 197

### 6. Buyback + burn with on-chain sha256 attestation
- image: posts/framed/attest.png
```
every burn's memo carries a sha256 of the exact revenue-event ids it settles.

so the chain from a payment to a destroyed token is reproducible on-chain by anyone. not a claim. a receipt.
```
- chars: 187

### 7. 85% of app revenue buys back and burns the coin
- image: posts/framed/money.png
```
an app charges its own users in USDC. 85% of that revenue swaps into the app's coin on the open market and burns it.

no dividend, no yield. the token supply just goes down as the product earns.
```
- chars: 194

### 8. Why a prompted app can't drain a wallet
- image: posts/safety.png
```
why a prompted app can't drain your wallet:

the agent never writes auth, wallet or payment code. that's platform-hosted via an SDK. apps run under a strict CSP with no outbound network, server logic in a QuickJS sandbox, and a reviewer gates every deploy.
```
- chars: 256

### 9. $BERTH: the platform coin, two one-way sinks, nothing paid to holders
- image: posts/framed/burned.png
```
$BERTH is the platform coin. two one-way sinks, nothing else:

buyback + burn, and staking to an app for build priority.

inflows are 25% of every app's fees and 10% of every app's revenue. holders are never paid.
```
- chars: 213

### 10. Dormancy: out of budget -> buy to revive; still serves + earns
- image: posts/dormant.png
```
run out of budget and the app goes behind a buy-to-revive page.

it keeps serving traffic and earning the whole time. only the build loop stops. any new fee restarts it.

dormant, not dead.
```
- chars: 189

### 11. Fees fund compute end to end (per-coin credits slice pays the model bill)
- image: posts/credits.png
```
fees fund compute end to end.

half of each coin's build cut is a credits slice, swept SOL to USDC to the card that pays the model bill. per-coin: a coin only ever spends credits its own fees earned.
```
- chars: 199

### 12. Holders steer the roadmap by token-weighted vote
- image: posts/framed/governance.png
```
holders steer the roadmap.

the prompt queue is token-weighted with a per-wallet cap, so no single wallet owns the direction. you vote on what the agent builds next.
```
- chars: 165

### 13. Every generated app is public and MIT; launchers assign no IP, get no equity/supply
- image: posts/opensource.png
```
every generated app is public and MIT.

the launcher assigns no IP and receives no equity and no supply allocation. you launch the coin; the code belongs to everyone.
```
- chars: 166

### 14. Refundable 0.05 SOL stake as spam control, returned at first build
- image: posts/stake.png
```
launching costs a refundable 0.05 SOL stake. it's spam control, and it pays the token-creation transaction.

you get it back the moment your coin funds its first build. a failed launch refunds immediately.
```
- chars: 205

### 15. First build kicks off at $50 of accrued budget; iterations at metered cost
- image: posts/buildgate.png
```
the first build kicks off at $50 of accrued budget.

after that, iterations run whenever budget clears $10 and are debited at the actual metered cost of the job, never a flat cap.
```
- chars: 179

### 16. A reviewer agent gates every deploy (blocks unsafe code, spec drift)
- image: posts/reviewer.png
```
a reviewer agent gates every deploy.

it blocks unsafe code and spec drift before anything ships. off-origin scripts, banned APIs, work that wandered from the approved spec: rejected. nothing reaches users ungated.
```
- chars: 214

### 17. Perimeter: strict CSP, no outbound network, QuickJS 64MB/5s, budget-capped tokens
- image: posts/perimeter.png
```
the perimeter around a generated app:

strict CSP, no outbound network, server logic in a QuickJS sandbox capped at 64MB and a 5s deadline, and model tokens metered per job against a budget.

blast radius by design.
```
- chars: 215

### 18. Merchant of record: USDC checkout, x402 per-call, ad slot, holder tier
- image: posts/revenue.png
```
the platform is merchant of record. an app can charge four ways:

USDC hosted checkout, x402 per-call payments, an ad slot, or a holder tier.

every revenue event is verified before it drives a buyback.
```
- chars: 202

### 19. Receipts: 211 tests, 31/0 security checks, 0 ledger drift, real pipeline in prod
- image: posts/receipts.png
```
receipts, not roadmap:

211 tests pass with no network. security perimeter 31 pass / 0 fail. reconcile reports 0 ledger drift. a real build pipeline runs in production end to end.

it stops at exactly one place: the credit balance.
```
- chars: 231

### 20. CTA: write one sentence, launch a coin that builds an app
- image: brand/banner.png
```
write one sentence. launch a coin that builds an app.

it funds its own build, charges its own users, and burns itself down as it earns.

berth.fun
```
- chars: 147
