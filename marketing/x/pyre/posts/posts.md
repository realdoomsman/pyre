# Pyre — 21 standalone posts

Display name `Pyre`, handle @PyreFun. Lowercase-declarative, no emoji, no price talk, buybacks are burns. Counts below use X's weighting (URLs count 23, most non-ASCII symbols count 2); every post is at or under 280.

Posting notes:
- One post per day after the pinned post (day 0). Days are suggestions; keep at least 20 h between posts. Skip weekends if reach drops.
- Attach the visual as a single image (1600×900). Alt text is given per post; paste it into X's alt field.
- Put links in the first reply unless the row says otherwise; X downranks link posts.
- Visuals 08, 09, 16 and 17 are diagrams only; nothing on the site is captured while the board is empty. Never attach a screenshot that shows numbers the site does not show today.
- Post 18 is the only place that talks about the PYRE launch. Never add a contract address or a date. Never write `$PYRE` with the dollar sign in a post or in alt text: X auto-links the cashtag to an unrelated asset.
- The 21st post (founder voice) can be dropped if exactly 20 are wanted; the rest do not depend on it.

| # | day | purpose | visual |
|---|---|---|---|
| 01 | 1 | the loop, end to end | `visuals/01-loop.png` |
| 02 | 4 | creator fee split with numbers | `visuals/02-fee-split.png` |
| 03 | 2 | the PYRE burn | `visuals/03-pyre-burn.png` |
| 04 | 7 | attestation calldata bytes | `visuals/04-attestation.png` |
| 05 | 10 | why pons v2 | `visuals/05-pons-v2.png` |
| 06 | 6 | what the agent can and cannot touch | `visuals/06-agent-scope.png` |
| 07 | 5 | the build gate | `visuals/07-build-gate.png` |
| 08 | 12 | dormant and relight | `visuals/08-ash.png` |
| 09 | 13 | ranking by what moved through the loop | `visuals/09-ranked.png` |
| 10 | 17 | custodial and external wallets | `visuals/10-wallets.png` |
| 11 | 11 | the reviewer agent's hard blocks | `visuals/11-hard-blocks.png` |
| 12 | 16 | the reconcile worker | `visuals/12-reconcile.png` |
| 13 | 14 | the independent security review and the High | `visuals/13-security-review.png` |
| 14 | 15 | test and audit numbers | `visuals/14-numbers.png` |
| 15 | 18 | the design system, heat not flame | `visuals/15-design.png` |
| 16 | 9 | the launch flow in three trays | `visuals/16-launch-trays.png` |
| 17 | 8 | how to verify a burn on blockscout | `visuals/17-verify-burn.png` |
| 18 | 20 | what is live vs what is next | `visuals/18-live-next.png` |
| 19 | 3 | faq: is a buyback a payout? no. | `visuals/19-faq.png` |
| 20 | 19 | open source, mit | `visuals/20-open-source.png` |
| 21 | 21 | founder voice: why we built this | `visuals/21-founder.png` |

## 01 · loop

- purpose: the loop, end to end
- day: 1
- visual: `visuals/01-loop.png`
- alt text: diagram: eight steps in a loop, from writing one sentence to a free app and a PYRE burn
- link: none in the post; first reply: https://pyre.fun
- count: 265 / 280

```
the loop: write one sentence. an intake agent writes the spec. stake 0.05 ETH, refundable. the coin launches on pons v2. its creator fees pay an agent to build the app. the app is free. 25% of every fee buys PYRE and burns it.

supply falls because the coin traded.
```

## 02 · fee-split

- purpose: creator fee split with numbers
- day: 4
- visual: `visuals/02-fee-split.png`
- alt text: proportional bars: the 1 percent trade fee, 70 percent to the app wallet, then split 60 build, 25 PYRE buyback, 15 launcher
- link: none; first reply: https://pyre.fun/burns (escrow address is in the visual)
- count: 273 / 280

```
where a trade fee goes on pyre.

every pons v2 trade pays 1%. 70% of that lands in the app's own wallet, claimed from the fee escrow every 5 minutes.

each claim splits: 60% build budget · 25% PYRE buyback · 15% to whoever launched it.

nothing on the fee side goes to us.
```

## 03 · pyre-burn

- purpose: the PYRE burn
- day: 2
- visual: `visuals/03-pyre-burn.png`
- alt text: one column sized 25 percent flowing from every coin into a single pool, and a four-step sequence ending in burn() and an attestation
- link: none; first reply: https://pyre.fun/burns
- count: 276 / 280

```
25% of every coin's creator fees goes to one place: a PYRE buyback that is burned.

it runs every 10 minutes once $5 is pooled. burn() is called on PYRE itself, so totalSupply actually falls. app coins are never bought back.

nothing goes to holders. supply just gets smaller.
```

## 04 · attestation

- purpose: attestation calldata bytes
- day: 7
- visual: `visuals/04-attestation.png`
- alt text: 37 hex byte cells: 50 59 52 45, 01, then a 32-byte sha256, with a worked example
- link: none; first reply: the article {ARTICLE_URL}
- count: 249 / 280

```
every burn ends with an attestation tx: a zero-value self-transfer from the treasury whose calldata is

0x5059524501 ‖ sha256(fee entry ids)

"PYRE", a version byte, a hash. the burn ledger shows the hash; compare it with the calldata on blockscout.
```

## 05 · pons-v2

- purpose: why pons v2
- day: 10
- visual: `visuals/05-pons-v2.png`
- alt text: a bonding curve rising to 4.2 ETH, a graduation marker, then a flat uniswap v4 line
- link: none; first reply: https://robinhoodchain.blockscout.com/address/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
- count: 270 / 280

```
why every pyre coin is a pons v2 launch: 1B supply on a bonding curve, a 1% trade fee, 70% of it to the creator wallet in both phases. at 4.2 ETH the curve closes and liquidity moves to a uniswap v4 pool held by pons' launch locker.

no pre-mine. the creator is the app.
```

## 06 · agent-scope

- purpose: what the agent can and cannot touch
- day: 6
- visual: `visuals/06-agent-scope.png`
- alt text: two-column table of what the agent writes and never writes, plus csp, quickjs, reviewer and budget facts
- link: none; first reply: https://github.com/realdoomsman/pyre/tree/main/packages/app-sdk
- count: 269 / 280

```
what the agent writes: the app.

what it never writes: auth, wallet code or anything that asks for money. auth sits behind @pyre/app-sdk; apps are free. it ships under a strict csp with no outbound network. server functions: QuickJS, 64 MB, 5 s.

it cannot reach a key.
```

## 07 · build-gate

- purpose: the build gate
- day: 5
- visual: `visuals/07-build-gate.png`
- alt text: terminal frame listing npm run build, playwright smoke, screenshots, lighthouse, reviewer, deploy; any gate fails means no deploy
- link: none
- count: 266 / 280

```
nothing deploys because the model said it was done.

every build has to pass, in order: npm run build · playwright smoke · screenshots · lighthouse · a reviewer model reading the diff against the approved spec.

any gate fails, nothing ships. the live version stays.
```

## 08 · ash

- purpose: dormant and relight
- day: 12
- visual: `visuals/08-ash.png`
- alt text: a heated tile marked live and an unlit tile marked dormant with the transitions between them
- link: none; first reply: https://pyre.fun/apps
- count: 239 / 280

```
when a coin's build budget runs out, it goes dormant. we call it ash.

the app stays up and keeps serving. only the agent stops.

the next fee claim that lifts the budget back over the $10 iteration minimum relights it. no vote, no button.
```

## 09 · ranked

- purpose: ranking by what moved through the loop
- day: 13
- visual: `visuals/09-ranked.png`
- alt text: a table of what ranks and what does not: fees claimed, trade volume and what the agent shipped rank; market cap does not
- link: none; first reply: https://pyre.fun/apps
- count: 238 / 280

```
the front page ranks by what moved through the loop: the fees a coin produced and what its agent shipped, not market cap. a coin whose app never got built sits under one that shipped v3.

the coin is the consequence. the app is the point.
```

## 10 · wallets

- purpose: custodial and external wallets
- day: 17
- visual: `visuals/10-wallets.png`
- alt text: two sign-in panels, google custodial and external wallet, and a note that apps are free and never ask either wallet for money
- link: none
- count: 271 / 280

```
two ways in. google sign-in gives you a custodial hd wallet on robinhood chain (m/44'/60'). or sign in with your own wallet via an eip-191 challenge, siwe-style.

neither wallet is ever charged inside an app. apps are free; holding a coin is the only thing an app checks.
```

## 11 · hard-blocks

- purpose: the reviewer agent's hard blocks
- day: 11
- visual: `visuals/11-hard-blocks.png`
- alt text: a diff view with twelve added lines each tagged with the pattern that blocks it, and one allowed sdk call
- link: none; first reply: https://github.com/realdoomsman/pyre/blob/main/apps/runner/src/build/reviewer.ts
- count: 268 / 280

```
before the reviewer model reads a diff, a mechanical pass rejects any shipping line with fetch(, XMLHttpRequest, WebSocket, an off-origin script src, privateKey, secretKey, privateKeyToAccount, sendTransaction, signTransaction, signTypedData, window.ethereum or eval(.
```

## 12 · reconcile

- purpose: the reconcile worker
- day: 16
- visual: `visuals/12-reconcile.png`
- alt text: seven tiles, JOBS to BURNS, one line each, and a cadence tile reading 5 min
- link: none; first reply: https://github.com/realdoomsman/pyre/tree/main/apps/runner/src/workers/reconcile
- count: 271 / 280

```
a reconcile worker runs 7 checks every 5 minutes:

JOBS settle dead builds
SANDBOXES kill orphaned microvms
JOBTOKENS revoke spent proxy tokens
PAYOUTS confirm broadcast payouts
LEDGER invariants, report only
FEES every claim has an event
BURNS ledger never exceeds chain
```

## 13 · security-review

- purpose: the independent security review and the High
- day: 14
- visual: `visuals/13-security-review.png`
- alt text: finding card: high, before and after, the four checks that now gate an external stake transaction
- link: none; first reply: https://github.com/realdoomsman/pyre/blob/main/apps/api/src/lib/launch.ts
- count: 279 / 280

```
pyre was reviewed independently. one high: an external-wallet launcher could point the stake at any inbound treasury tx, a fee sweep say, and get it refunded.

fixed: the tx must be mined, to the treasury, worth the stake, from the launcher's proven wallet. one hash, one launch.
```

## 14 · numbers

- purpose: test and audit numbers
- day: 15
- visual: `visuals/14-numbers.png`
- alt text: three large numbers: unit tests, production features passing, and 1 high and 5 medium review findings fixed
- link: none; first reply: https://github.com/realdoomsman/pyre
- count: fill after the post-cutover audit

```
where the engineering stands.

{TESTS} unit tests, no network.
production feature audit: {PASS} of {TOTAL} pass; the rest wait only on treasury funding.
independent security review: 1 high, 5 medium, all fixed.

every number is reproducible from the public repo.
```

Fill `{TESTS}`, `{PASS}` and `{TOTAL}` from the first post-cutover run recorded in `docs/go-live.md`; the 408 / 62 / 68 figures from 2026-09-21 include two payment checks that no longer exist and must not be reposted.

## 15 · design

- purpose: the design system, heat not flame
- day: 18
- visual: `visuals/15-design.png`
- alt text: isometric kiln of ten blocks with the top three hollow, the palette swatches, the heat ramp and the three typefaces
- link: none; first reply: https://github.com/realdoomsman/pyre/blob/main/marketing/brand/pyre/BRAND.md
- count: 279 / 280

```
heat, not flame. pyre shows fire only through its consequence: an obsidian tile with a tempered bottom edge, violet to cobalt to white. hotter than orange.

every coin's supply is a kiln: blocks that hollow out as burns land. instrument serif, geist, geist mono. no flame glyphs.
```

## 16 · launch-trays

- purpose: the launch flow in three trays
- day: 9
- visual: `visuals/16-launch-trays.png`
- alt text: three tray mockups: coin, agent brief, review and launch, with the fields labelled and empty
- link: none; first reply: https://pyre.fun/launch
- count: 274 / 280

```
launching is three trays.

01 coin: name, ticker, one sentence on what to build.
02 agent brief: an intake agent writes the spec: what it does, who it is for, mvp, holder tier. you approve it.
03 review and launch: stake 0.05 ETH, refunded at the first build.

then pons v2.
```

## 17 · verify-burn

- purpose: how to verify a burn on blockscout
- day: 8
- visual: `visuals/17-verify-burn.png`
- alt text: four numbered steps to verify a burn: open the ledger row, check totalSupply on the burn tx, read the attestation calldata, recompute the hash
- link: none; first reply: https://pyre.fun/burns
- count: 261 / 280

```
how to check a pyre burn yourself.

open the burn ledger, pick a row. burn tx: on blockscout PYRE's totalSupply drops by the burned amount, nothing moves to a wallet. attestation tx: calldata starts 0x5059524501, the rest is the hash shown on that row. compare.
```

## 18 · live-next

- purpose: what is live vs what is next
- day: 20
- visual: `visuals/18-live-next.png`
- alt text: two lists, live and next; the next list says PYRE launches soon with no contract address yet
- link: none
- count: 272 / 280

```
live: the site, the api, the launch flow, the build pipeline, the burn ledger and attestation, the public repo.

next: PYRE launches soon. the treasury gets funded, which clears the audit checks waiting on it.

no contract address exists yet. anyone posting one is not us.
```

## 19 · faq

- purpose: faq: is a buyback a payout? no.
- day: 3
- visual: `visuals/19-faq.png`
- alt text: large serif question, is a buyback a payout, answered no, with three shorter questions below
- link: none; first reply: https://pyre.fun/legal/terms
- count: 275 / 280

```
is a buyback a payout? no.

nothing is sent to holders, ever. 25% of every coin's fees buys PYRE and burn() destroys it. app coins are never bought back. supply falls; that is the whole effect.

not yield, not a dividend, not a fee share. the terms say so because it is true.
```

## 20 · open-source

- purpose: open source, mit
- day: 19
- visual: `visuals/20-open-source.png`
- alt text: file tree of the public repository with one line per package and a panel reading mit, all of it
- link: in the post: github.com/realdoomsman/pyre
- count: 218 / 280

```
pyre is open source under mit. the chain client, the api, the runner, the web app, the app sdk, the audits and the scripts behind every number we quote.

read what runs before you launch on it.

github.com/realdoomsman/pyre
```

## 21 · founder

- purpose: founder voice: why we built this
- day: 21
- visual: `visuals/21-founder.png`
- alt text: three short serif paragraphs on why pyre was built
- link: none; quote the pinned post instead of linking
- count: 273 / 280

```
why we built this.

launchpads solved launching and skipped the part where something gets built. a coin would trade for a day and leave nothing behind.

we wanted a coin whose fees build something real and burn PYRE, with receipts on chain. pyre is that. small, real, open.
```

## published state (2026-09-21)

- Article: https://x.com/PyreFun/status/2102044469059027329 (X Article, 11 figures, cover = banner)
- Pinned post (quote of the article + `video/pyre-launch.mp4` + captions): https://x.com/PyreFun/status/2102045570156155274
- Day 1 (post 01) published: https://x.com/PyreFun/status/2102047451544735931 with `https://pyre.fun` in the first reply
- Days 2–21 scheduled in X's native scheduler, one per day at 15:00 local, Sep 22 → Oct 11 (order per the table above). Manage at x.com/compose/post/unsent/scheduled.
- Profile set: avatar `pfp.png`, header `banner.png`, bio/location/website per profile.md.
- Replies posted (5): to @Captainweb01, @PaydRH, @portgost, @MIOnMinara, @lemondotfun (see replies.md for the voice rules).

**Stale scheduled posts (production purged 2026-09-21; apps made free 2026-09-22).** Every scheduled copy of posts 02–21 was uploaded with the earlier loop (in-app payments and an app-coin buyback) or the earlier audit numbers. Replace each one in the scheduler with the copy and the re-rendered visual in this file before its day; post 01 (already published) is superseded by the pinned post's replacement.

**Cashtag warning.** X's composer auto-resolves the `$PYRE` cashtag to an unrelated asset (`robinhood:0x0d11e308e40c15e1181aed4f4bbfc4744e9deeed`) and shows that in the post. Until our coin is live and X maps the cashtag to it, write `PYRE` (no `$`) in posts; posts 02, 03 and 18 were scheduled that way.
