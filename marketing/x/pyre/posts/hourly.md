# Pyre — 24 hourly posts (2026-09-23)

Display name `Pyre`, handle @PyreFun. One post per hour for the next 24 hours; hour 1 is the next full hour. Same rules as `posts.md`: lowercase-declarative, numbers over adjectives, no emoji, no price talk (no market caps, no % moves, no "up"), buybacks are burns and never distributions, "coin" not "token", `pons`/`pump.fun` lowercase, and PYRE is always written bare — never with a leading dollar sign, because X's composer still resolves that cashtag to an unrelated asset. No post here quotes a price, so no post here carries a disclaimer.

Counts are X-weighted (URLs and bare domains 23) and were computed with `weigh()` from `../media/src/count.mjs`. Every count below is at or under 280.

Every number is true as of 2026-09-23: two venues live (robinhood chain · pons v2, stake 0.05 ETH; solana · pump.fun, stake 1 SOL), 123 launches created, 7 coins live, 139 sign-ups, 5,993 indexed trades, 517 fee claims, 18 successful agent builds, apps basket v5 (133 holders), pyrecat v4 (124 holders), paperhood v3, jackpot v3, 36 PYRE buy-and-burns (0.2679 ETH spent, 2,210,062 PYRE burned, 0.221% of supply), 493 unit tests, security review 1 high / 5 medium / 5 low all fixed. Refresh a number upward before posting; never post a smaller one.

Posting notes:
- Visual paths are relative to this file (`visuals/…` and `../media/img/…`). `FRESH:` rows name the exact page to capture: 1600×900, dark build, no browser chrome, signed out, taken close to the posting hour so the numbers on screen match or exceed the copy.
- Links go in the first reply, not the post.
- The PYRE contract address appears in no post here and in no alt text or reply here; `../media/posts2.md` 04 owns it.
- None of this copy repeats the 14 cards in `posts.md`, the 4 media posts in `../media/posts2.md`, or the 4 unscheduled multichain posts at the foot of `posts.md`.
- Retired visuals, not cited here: `visuals/03-pyre-burn.png` (its "app coins bought back: 0" stat is false now that the solana venue burns app coins), `visuals/02-fee-split.png` (frames the 1% fee as pons-only), `visuals/01-loop.png`, `visuals/07-build-gate.png`, `visuals/05-pons-v2.png`, `visuals/10-wallets.png`, `visuals/16-launch-trays.png` (all single-venue), `visuals/08-ash.png`, `visuals/09-ranked.png`, `visuals/14-numbers.png`, `visuals/15-design.png`, `visuals/18-live-next.png`, `visuals/03-revenue-burn.png`, and every `../media/img/*.png` (the 11–15 set is a 2026-09-22 capture: 15 burns, 0.144 ETH, and market-cap and 24h-move panels that would put price talk in the image).

| # | slug | count | visual |
|---|---|---|---|
| 01 | two-venues | 242 | FRESH |
| 02 | today | 189 | FRESH |
| 03 | at-fifty | 256 | none |
| 04 | free | 170 | none |
| 05 | burns | 254 | visuals/04-attestation.png |
| 06 | spec | 255 | none |
| 07 | basket | 237 | FRESH |
| 08 | solana-burn | 228 | none |
| 09 | claims | 231 | none |
| 10 | one-chain | 199 | none |
| 11 | buyback | 212 | none |
| 12 | pyrecat | 219 | FRESH |
| 13 | stake | 213 | none |
| 14 | apps | 247 | FRESH |
| 15 | source | 197 | visuals/20-open-source.png |
| 16 | refused | 252 | none |
| 17 | no-network | 256 | visuals/11-hard-blocks.png |
| 18 | review | 202 | none |
| 19 | build-log | 230 | FRESH |
| 20 | roadmap | 93 | none |
| 21 | launcher | 220 | none |
| 22 | reconcile | 250 | visuals/12-reconcile.png |
| 23 | template | 241 | none |
| 24 | read-it | 207 | FRESH |

## 01 · two-venues

- purpose: two venues, and the launch page makes you pick
- hour: 1
- visual: FRESH: https://pyre.fun/launch — the venue step at 1600x900, signed out, showing both venues with their stakes
- alt text: the launch page venue step: two cards side by side, robinhood chain with pons v2 and a 0.05 ETH stake, solana with pump.fun and a 1 SOL stake
- link: none in the post; first reply: https://pyre.fun/launch
- count: 242 / 280

```
two venues now.

robinhood chain · pons v2, stake 0.05 ETH.
solana · pump.fun, stake 1 SOL.

the launch page asks which one before it asks anything else. either stake is refunded to you the moment your app's first build starts.
```

## 02 · today

- purpose: where the platform actually stands this morning
- hour: 2
- visual: FRESH: https://pyre.fun — home signed out at 1600x900, stat strip and feed
- alt text: pyre.fun home on a dark canvas: the stat strip above a feed of live coins, each with its build state
- link: none in the post; first reply: https://pyre.fun
- count: 189 / 280

```
pyre today: 123 launches created, 7 coins live, 18 agent builds finished, 517 fee claims, 5,993 trades indexed, 36 PYRE burns, 139 sign-ups.

none of it is seeded and none of it is rounded.
```

## 03 · at-fifty

- purpose: how a build is funded and what runs when it starts
- hour: 3
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://github.com/realdoomsman/pyre/tree/main/apps/runner/src/build
- count: 256 / 280

```
a build starts at $50.

trading fees accrue to the coin's own wallet until the build budget reaches fifty dollars. then a microvm boots on e2b and the claude agent sdk is handed two things: the spec you approved, and a fixed template. it works inside that.
```

## 04 · free

- purpose: the apps cost nothing to use
- hour: 4
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://pyre.fun/apps
- count: 170 / 280

```
the apps are free. no checkout, no subscription, no per-call fee, no ads. holding the coin unlocks the extra features. the coin's trading fees already paid for the build.
```

## 05 · burns

- purpose: the burn total, with the receipt format
- hour: 5
- visual: `visuals/04-attestation.png`
- alt text: 37 hex byte cells: 50 59 52 45, then 01, then a 32-byte sha256, with a worked example of the fee entry ids behind it
- link: none in the post; first reply: https://pyre.fun/burns
- count: 254 / 280

```
36 buy-and-burns so far: 0.2679 ETH spent, 2,210,062 PYRE destroyed, 0.221% of supply gone for good.

each one is three transactions: the swap, the burn, and an attestation carrying 0x5059524501 followed by the sha256 of the fee entries that paid for it.
```

## 06 · spec

- purpose: you approve the spec before the coin exists
- hour: 6
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://pyre.fun/launch
- count: 255 / 280

```
an intake agent reads your sentence and writes the spec: what the app does, what it looks like, what holding the coin unlocks.

you approve it or you change it. the coin does not launch until you approve, and the agent builds nothing that is not in there.
```

## 07 · basket

- purpose: the first app, as it stands today
- hour: 7
- visual: FRESH: https://basket.pyre.fun — gallery at 1600x900, signed out, no browser chrome
- alt text: basket.pyre.fun: a gallery of weighted baskets of pyre coins, each showing its legs and per-leg weights in pyre's dark design system
- link: none in the post; first reply: https://basket.pyre.fun
- count: 237 / 280

```
basket.pyre.fun is on v5, with 133 holders.

weighted baskets of pyre coins, exact-cent sizing per leg, a trade link for each one. an agent wrote it from one sentence, and the coin's own trading fees paid for every version since.
```

## 08 · solana-burn

- purpose: what the 25% does on the solana venue
- hour: 8
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://pyre.fun/legal/terms
- count: 228 / 280

```
on solana the 25% cannot buy PYRE, because PYRE only exists on robinhood chain. so it buys the coin that earned the fee and burns that instead.

the split does not change with the venue: 60% build budget, 25% burn, 15% launcher.
```

## 09 · claims

- purpose: the claim worker and what 517 claims means
- hour: 9
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://pyre.fun/burns
- count: 231 / 280

```
517 fee claims so far.

a worker sweeps each coin's creator fees out of escrow every 5 minutes and splits them the same way every time: 60 to the build budget, 25 to a burn, 15 to whoever launched the coin. no one approves a claim.
```

## 10 · one-chain

- purpose: PYRE is single-chain; impostors are not ours
- hour: 10
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://pyre.fun/pyre
- count: 199 / 280

```
PYRE exists on robinhood chain and nowhere else. not bridged, not wrapped, not deployed a second time.

anything called PYRE on another chain is not ours. it earns nothing here and we cannot burn it.
```

## 11 · buyback

- purpose: the buyback rule: $5 pooled, checked every 10 minutes
- hour: 11
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://pyre.fun/burns
- count: 212 / 280

```
the buyback is a rule, not a decision.

it checks every 10 minutes, and once $5 of fee share has pooled it runs: a swap, then burn(), which lowers total supply. no one picks the moment and no one signs off on it.
```

## 12 · pyrecat

- purpose: the second app, and that a person wrote none of it
- hour: 12
- visual: FRESH: https://pyrecat.pyre.fun — the app at 1600x900, signed out, no browser chrome
- alt text: pyrecat.pyre.fun: a cat persona generator in pyre's dark design system
- link: none in the post; first reply: https://pyrecat.pyre.fun
- count: 219 / 280

```
pyrecat.pyre.fun, v4, 124 holders. it generates cat personas.

that is the whole app, and no person wrote it. a sentence went into intake, the coin launched, its trading fees crossed $50, and an agent shipped it.
```

## 13 · stake

- purpose: the stake is refundable, and what it is for
- hour: 13
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://pyre.fun/launch
- count: 213 / 280

```
the stake is not a fee. 0.05 ETH on robinhood chain, 1 SOL on solana, and you get it back the moment your app's first build starts.

it is there to make a throwaway launch cost something. a real one costs nothing.
```

## 14 · apps

- purpose: every deployed app and its version
- hour: 14
- visual: FRESH: https://pyre.fun/apps — the app store at 1600x900, signed out
- alt text: pyre.fun/apps: deployed apps as cards, each with its coin, its version and an open-app button
- link: none in the post; first reply: https://pyre.fun/apps
- count: 247 / 280

```
the apps, all free to open: basket (weighted coin baskets, v5), pyrecat (cat personas, v4), paperhood, jackpot and pyredog (v3 each).

each one lives at its own name under pyre.fun and gets rebuilt when its coin's fees fund the next version.
```

## 15 · source

- purpose: the code behind every number we post
- hour: 15
- visual: `visuals/20-open-source.png`
- alt text: file tree of the public repository with one line per package and a panel reading mit, all of it
- link: in the post: github.com/realdoomsman/pyre (counted as 23 above); no reply needed
- count: 197 / 280

```
every number in this account comes out of code you can read: the fee sweep, the buyback, the coin burn, the reconcile checks, the burn ledger. mit licensed, 493 unit tests.

github.com/realdoomsman/pyre
```

## 16 · refused

- purpose: moderation, and that a refusal is free
- hour: 16
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://pyre.fun/legal/terms
- count: 252 / 280

```
a classifier reads the sentence before the intake agent does. real-money gambling, piracy and scam-styled prompts are refused.

a refusal costs you nothing: it never becomes a coin, and it does not count against the 5 launches a day a new account gets.
```

## 17 · no-network

- purpose: apps have no network reach; they read their own origin
- hour: 17
- visual: `visuals/11-hard-blocks.png`
- alt text: a diff view with twelve added lines each tagged with the pattern that blocks it, and one allowed sdk call
- link: none in the post; first reply: https://github.com/realdoomsman/pyre/blob/main/apps/runner/src/build/reviewer.ts
- count: 256 / 280

```
an app the agent builds does not call the internet. a mechanical diff scan rejects fetch(, XMLHttpRequest, WebSocket and off-origin script tags before a reviewer model even reads the code.

it reads live coin data from its own origin: /_pyre/coins, no key.
```

## 18 · review

- purpose: the independent security review, all findings closed
- hour: 18
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://github.com/realdoomsman/pyre/tree/main/audits
- count: 202 / 280

```
an independent security review of pyre found 1 high, 5 medium and 5 low. all eleven are fixed.

the report and the commits that closed each finding are in the public repo, next to the code they changed.
```

## 19 · build-log

- purpose: every build is readable, not summarised
- hour: 19
- visual: FRESH: https://pyre.fun/c/basket — the build log tab at 1600x900, signed out, terminal frame with real rows
- alt text: a coin page build log: a dark terminal frame with one row per tool call from a real agent build
- link: none in the post; first reply: https://pyre.fun/c/basket
- count: 230 / 280

```
every agent build writes a log, and you can read it from the coin's page: the spec it was given, each tool call as it lands, and how the run ended.

18 builds have finished that way. none of them shipped on the model's word alone.
```

## 20 · roadmap

- purpose: dry one-liner: what ships next is decided by fees
- hour: 20
- visual: none (text post)
- alt text: n/a
- link: none
- count: 93 / 280

```
there is no roadmap. the next app to ship is whichever coin's build budget crosses $50 first.
```

## 21 · launcher

- purpose: the 15% launcher share
- hour: 21
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://pyre.fun/burns
- count: 220 / 280

```
15% of every fee claim goes to the person who launched the coin. no vesting, no application, no cliff: it lands in their wallet in the same claim that funds the build and the burn.

517 claims have split that way so far.
```

## 22 · reconcile

- purpose: the numbers are checked against the chain, not asserted
- hour: 22
- visual: `visuals/12-reconcile.png`
- alt text: seven tiles, JOBS to BURNS, one line each, and a cadence tile reading 5 min
- link: none in the post; first reply: https://github.com/realdoomsman/pyre/tree/main/apps/runner/src/workers/reconcile
- count: 250 / 280

```
none of these numbers are typed in by hand. 5,993 trades indexed, 517 fee claims recorded against chain events, 36 burns checked against what the chain actually shows.

a reconcile worker runs seven checks every 5 minutes and reports whatever drifts.
```

## 23 · template

- purpose: every app starts from the same template, so a diff is reviewable
- hour: 23
- visual: none (text post)
- alt text: n/a
- link: none in the post; first reply: https://github.com/realdoomsman/pyre/tree/main/apps/runner/src/build
- count: 241 / 280

```
the agent does not pick a stack. every app starts from the same template: same framework, same dark canvas, same type, same sdk.

the model fills in the app, not the scaffolding. that is why a whole build can be reviewed by reading one diff.
```

## 24 · read-it

- purpose: closing: where to read all of it, signed out
- hour: 24
- visual: FRESH: https://pyre.fun/burns — the ledger at 1600x900, signed out, rows visible
- alt text: pyre.fun/burns: eth burned and burn count at the top, then the ledger with one row per burn, each linking a swap tx, a burn tx and an attestation tx
- link: in the post: pyre.fun (counted as 23 above); first reply: https://pyre.fun/burns
- count: 207 / 280

```
all of it is readable signed out. the burns page lists every burn with its swap, its burn and its attestation. each coin page carries its build log and a link to the app it paid for.

pyre.fun
```
