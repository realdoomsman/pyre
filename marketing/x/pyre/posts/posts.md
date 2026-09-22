# Pyre — 14 standalone posts (live-platform set, 2026-09-22)

Display name `Pyre`, handle @PyreFun. Lowercase-declarative, no emoji, no price talk, buybacks are burns never distributions, "coin" not "token", `PYRE` never `$PYRE`. Counts below use X's weighting (URLs and bare domains count 23, most non-ASCII symbols count 2); every post is at or under 280.

Every number in this file is real as of 2026-09-22 08:00 UTC: 67 launches created, 6 coins live, 3 apps deployed, 3 building, 107 fee claims totalling 0.593 ETH, 14 PYRE burns (0.141 ETH spent, 1,372,423 PYRE burned, 0.137% of supply), 4 launches refused by the classifier, 413 unit tests, security review 1 high / 5 medium / 5 low all fixed. Refresh a number before posting only if it has grown; never post a smaller one.

Posting notes:
- Day 1 is 2026-09-23. Cards go out at 15:00 local, one per day, days 1–14 (Sep 23 → Oct 6). The 11:00 slot on the same days is the media wave in `../media/posts2.md`; never more than two posts a day.
- Attach the visual as a single image (1600×900). Alt text is given per post; paste it into X's alt field. `visual: FRESH:` means capture or re-render before scheduling; the old file is misleading and must not be attached.
- Put links in the first reply unless the row says otherwise; X downranks link posts.
- The PYRE contract address appears in exactly one post (`../media/posts2.md` 04 · pyre-page). Never paste it into alt text or a reply of any other post.
- Never write `$PYRE` in a post or in alt text; X's composer still resolves the cashtag to an unrelated asset. Other tickers may carry the `$`.
- The production feature audit is being re-run after the stale probes were fixed. Do not quote a pass count anywhere; "re-running" is the only true statement today.

| # | day | date · 15:00 | purpose | visual |
|---|---|---|---|---|
| 01 | 1 | Sep 23 | the loop, end to end, with day-one counts | `visuals/01-loop.png` |
| 02 | 2 | Sep 24 | the PYRE burn, 14 so far | `visuals/03-pyre-burn.png` |
| 03 | 3 | Sep 25 | what broke on day one and what we changed | none (text post) |
| 04 | 4 | Sep 26 | the build gate, with basket's real run | `visuals/07-build-gate.png` |
| 05 | 5 | Sep 27 | creator fee split, 107 claims | `visuals/02-fee-split.png` |
| 06 | 6 | Sep 28 | faq: is a buyback a payout? no. | `visuals/19-faq.png` |
| 07 | 7 | Sep 29 | attestation calldata bytes | `visuals/04-attestation.png` |
| 08 | 8 | Sep 30 | the mechanical diff pass before the reviewer | `visuals/11-hard-blocks.png` |
| 09 | 9 | Oct 1 | the independent security review and the High | `visuals/13-security-review.png` |
| 10 | 10 | Oct 2 | the reconcile worker | `visuals/12-reconcile.png` |
| 11 | 11 | Oct 3 | refused launches and the classifier | FRESH: card, refused intakes |
| 12 | 12 | Oct 4 | the design system every app ships with | FRESH: basket.pyre.fun beside pyre.fun |
| 13 | 13 | Oct 5 | open source, mit, 413 tests | `visuals/20-open-source.png` |
| 14 | 14 | Oct 6 | founder voice: why we built this | `visuals/21-founder.png` |

Accurate spares, not scheduled: `visuals/05-pons-v2.png`, `visuals/06-agent-scope.png`, `visuals/10-wallets.png`, `visuals/16-launch-trays.png`, `visuals/17-verify-burn.png`. Retired, do not post: `visuals/08-ash.png` (dormant/relight copy not re-verified), `visuals/09-ranked.png` (the feed does not rank by fees), `visuals/14-numbers.png` (placeholder dashes), `visuals/15-design.png` (kiln), `visuals/18-live-next.png` ("PYRE launches soon"), `visuals/03-revenue-burn.png` (revenue loop).

## 01 · loop

- purpose: the loop, end to end, with day-one counts
- day: 1 · Sep 23 · 15:00
- visual: `visuals/01-loop.png`
- alt text: diagram: eight steps in a loop, from writing one sentence to a free app and a PYRE burn
- link: none in the post; first reply: https://pyre.fun
- count: 276 / 280

```
the loop: write one sentence. an intake agent writes the spec. stake 0.05 ETH, refundable. the coin launches on pons v2. its fees pay an agent to build the app. the app is free. 25% of every fee buys PYRE and burns it.

one day in: 67 launches, 6 coins live, 3 apps, 14 burns.
```

## 02 · pyre-burn

- purpose: the PYRE burn, 14 so far
- day: 2 · Sep 24 · 15:00
- visual: `visuals/03-pyre-burn.png`
- alt text: one column sized 25 percent flowing from every coin into a single pool, and a four-step sequence ending in burn() and an attestation
- link: none; first reply: https://pyre.fun/burns
- count: 276 / 280

```
25% of every coin's creator fees goes to one place: a PYRE buyback that is burned.

14 burns so far: 0.141 ETH spent, 1,372,423 PYRE burned, 0.137% of supply. each is a swap tx, a burn tx and an attestation tx on robinhood chain.

nothing goes to holders. supply gets smaller.
```

## 03 · day-one

- purpose: what broke on day one and what we changed
- day: 3 · Sep 25 · 15:00
- visual: none (text post)
- alt text: n/a
- link: none; first reply: https://github.com/realdoomsman/pyre/tree/main/apps/runner/src/workers/reconcile
- count: 271 / 280

```
what broke on day one and what we changed.

a runner redeploy orphaned a build mid-flight. orphans now settle and requeue.

a stale push rejected a deploy. the verified tree now wins the merge.

a rate limit hit a real launcher. verified users now get 5x the ip headroom.
```

## 04 · build-gate

- purpose: the build gate, with basket's real run
- day: 4 · Sep 26 · 15:00
- visual: `visuals/07-build-gate.png`
- alt text: terminal frame listing npm run build, playwright smoke, screenshots, lighthouse, reviewer, deploy; any gate fails means no deploy
- link: none; first reply: https://basket.pyre.fun
- count: 273 / 280

```
nothing deploys because the model said it was done.

every build passes, in order: npm run build · playwright smoke · screenshots · lighthouse · a mechanical diff pass · a reviewer model reading the diff against the spec.

basket v1: 5/5 playwright, lighthouse 85/96/96/91.
```

## 05 · fee-split

- purpose: creator fee split, 107 claims
- day: 5 · Sep 27 · 15:00
- visual: `visuals/02-fee-split.png`
- alt text: proportional bars: the 1 percent trade fee, 70 percent to the app wallet, then split 60 build, 25 PYRE buyback, 15 launcher
- link: none; first reply: https://pyre.fun/burns (escrow address is in the visual)
- count: 274 / 280

```
where a trade fee goes on pyre.

every pons v2 trade pays 1%. 70% of that lands in the app's own wallet, claimed from the fee escrow every 5 minutes.

each claim splits: 60% build budget · 25% PYRE burn · 15% launcher.

107 claims so far, 0.593 ETH. none of it goes to pyre.
```

## 06 · faq

- purpose: faq: is a buyback a payout? no.
- day: 6 · Sep 28 · 15:00
- visual: `visuals/19-faq.png`
- alt text: large serif question, is a buyback a payout, answered no, with three shorter questions below
- link: none; first reply: https://pyre.fun/legal/terms
- count: 275 / 280

```
is a buyback a payout? no.

nothing is sent to holders, ever. 25% of every coin's fees buys PYRE and burn() destroys it. app coins are never bought back. supply falls; that is the whole effect.

not yield, not a dividend, not a fee share. the terms say so because it is true.
```

## 07 · attestation

- purpose: attestation calldata bytes
- day: 7 · Sep 29 · 15:00
- visual: `visuals/04-attestation.png`
- alt text: 37 hex byte cells: 50 59 52 45, 01, then a 32-byte sha256, with a worked example
- link: none; first reply: https://pyre.fun/burns
- count: 274 / 280

```
every burn ends with an attestation tx: a zero-value self-transfer from the treasury whose calldata is

0x5059524501 ‖ sha256(fee entry ids)

"PYRE", a version byte, a hash. the burn ledger shows the hash; compare it with the calldata on blockscout. 14 rows to check so far.
```

## 08 · hard-blocks

- purpose: the mechanical diff pass before the reviewer
- day: 8 · Sep 30 · 15:00
- visual: `visuals/11-hard-blocks.png`
- alt text: a diff view with twelve added lines each tagged with the pattern that blocks it, and one allowed sdk call
- link: none; first reply: https://github.com/realdoomsman/pyre/blob/main/apps/runner/src/build/reviewer.ts
- count: 268 / 280 (X's composer; `count.mjs` says 276 because it weighs `window.ethereum` as a link, which X does not)

```
before the reviewer model reads a diff, a mechanical pass rejects any shipping line with fetch(, XMLHttpRequest, WebSocket, an off-origin script src, privateKey, secretKey, privateKeyToAccount, sendTransaction, signTransaction, signTypedData, window.ethereum or eval(.
```

## 09 · security-review

- purpose: the independent security review and the High
- day: 9 · Oct 1 · 15:00
- visual: `visuals/13-security-review.png`
- alt text: finding card: high, before and after, the four checks that now gate an external stake transaction
- link: none; first reply: https://github.com/realdoomsman/pyre/blob/main/apps/api/src/lib/launch.ts
- count: 279 / 280

```
pyre was reviewed independently. one high: an external-wallet launcher could point the stake at any inbound treasury tx, a fee sweep say, and get it refunded.

fixed: the tx must be mined, to the treasury, worth the stake, from the launcher's proven wallet. one hash, one launch.
```

## 10 · reconcile

- purpose: the reconcile worker
- day: 10 · Oct 2 · 15:00
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

## 11 · refused

- purpose: refused launches and the classifier
- day: 11 · Oct 3 · 15:00
- visual: FRESH: a card in the `visuals/` style: "4 of 67 refused", the three refusal reasons as rows, and a footer "refused intakes do not count against 5 launches a day"
- alt text: card: four launches refused out of sixty-seven, listed as real-money gambling, rom piracy and a scam-styled coin, with a note that refused intakes do not count against the daily launch limit
- link: none; first reply: https://pyre.fun/legal/terms
- count: 278 / 280

```
launches refused so far: 4. real-money gambling, rom piracy, a scam-styled coin.

a classifier reads the sentence before the intake agent does. a refused intake never becomes a coin and does not count against a new account's 5 launches a day.

67 launches created. 6 coins live.
```

## 12 · design

- purpose: the design system every app ships with
- day: 12 · Oct 4 · 15:00
- visual: FRESH: basket.pyre.fun and pyre.fun side by side at 1600×900, no browser chrome, showing the shared obsidian canvas, violet accent and type
- alt text: two screenshots side by side, basket.pyre.fun and pyre.fun, sharing the same dark canvas, violet accent, serif headings and monospace numbers
- link: none; first reply: https://github.com/realdoomsman/pyre/blob/main/marketing/brand/pyre/BRAND.md
- count: 267 / 280

```
every app the agent ships wears pyre's design system: obsidian, ink, tempered violet. instrument serif for the voice, geist for the ui, geist mono for every number.

enforced by lint, not taste. a warm accent, a light theme or a flame glyph is rejected before deploy.
```

## 13 · open-source

- purpose: open source, mit, 413 tests
- day: 13 · Oct 5 · 15:00
- visual: `visuals/20-open-source.png`
- alt text: file tree of the public repository with one line per package and a panel reading mit, all of it
- link: in the post: github.com/realdoomsman/pyre
- count: 277 / 280

```
pyre is open source under mit. the chain client, the api, the runner, the web app, the app sdk, the audits and the scripts behind every number we quote.

413 unit tests. every app the agent builds is public too.

read what runs before you launch on it.

github.com/realdoomsman/pyre
```

## 14 · founder

- purpose: founder voice: why we built this
- day: 14 · Oct 6 · 15:00
- visual: `visuals/21-founder.png`
- alt text: three short serif paragraphs on why pyre was built
- link: none; quote the pinned post instead of linking
- count: 273 / 280

```
why we built this.

launchpads solved launching and skipped the part where something gets built. a coin would trade for a day and leave nothing behind.

we wanted a coin whose fees build something real and burn PYRE, with receipts on chain. pyre is that. small, real, open.
```

## published state (2026-09-21) and the cutover

- Article: https://x.com/PyreFun/status/2102044469059027329 (X Article, 11 figures, cover = banner)
- Pinned post (quote of the article + `video/pyre-launch.mp4` + captions): https://x.com/PyreFun/status/2102045570156155274
- Day 1 (old post 01) published: https://x.com/PyreFun/status/2102047451544735931 with `https://pyre.fun` in the first reply
- Profile set: avatar `pfp.png`, header `banner.png`, bio/location/website per profile.md.
- Replies posted (5): to @Captainweb01, @PaydRH, @portgost, @MIOnMinara, @lemondotfun (see replies.md for the voice rules).

**2026-09-22.** PYRE launched, basket shipped, 14 burns landed. Every post scheduled on 2026-09-21 (old 02–21, one per day Sep 22 → Oct 11) was written for a pre-launch world and is deleted from x.com/compose/post/unsent/scheduled; the 14 posts above and the 4 in `../media/posts2.md` replace them.

**Cashtag warning.** X's composer auto-resolves the `$PYRE` cashtag to an unrelated asset (`robinhood:0x0d11e308e40c15e1181aed4f4bbfc4744e9deeed`) and shows that in the post. Write `PYRE` (no `$`) in posts and alt text until X maps the cashtag to `0xc8488bE2e4f430420A364E64f4D8af428b74D903`.

## after the multichain update ships — 4 standalone posts, not scheduled

Written 2026-09-22 for the `multichain` branch (Solana · pump.fun as a second venue). None of these go out before the announcement and ship-day posts in `multichain.md`, and none before the venue is live in production; they do not touch the 14 scheduled cards above. Slot them at 15:00 on days with no scheduled card, or after Oct 6. Same rules as the top of this file; `pump.fun` is a bare domain and costs 23 characters each time. Every rate quoted here is pump.fun's, not ours, and can change — never present it as a Pyre number.

### M1 · coin-burn

- purpose: what the 25% does on solana, and why it is not PYRE
- visual: `FRESH:` a solana coin page's "coin burned" panel at 1600×900 with a real memo signature, no browser chrome
- alt text: a coin page panel titled coin burned, listing a swap signature, a burn signature and a memo attestation signature with a hash
- link: none; first reply: the coin's page on pyre.fun
- count: 268 / 280

```
a solana coin's 25% cannot buy PYRE, because PYRE only exists on robinhood chain. so it buys the coin itself and burns it: a swap, a burn that lowers supply, and a memo reading pyre:burn:v1:<sha256>. open the signature on solscan and check it. nothing goes to holders.
```

### M2 · two-wallets

- purpose: the account page now has two custodial wallets; solana is custodial only
- visual: `FRESH:` `/me` at 1600×900 showing both addresses and deposit trays (SOL QR visible), balances blurred or zero, no browser chrome
- alt text: the account page with two custodial addresses, one on robinhood chain and one on solana, each with a deposit tray
- link: none; first reply: https://pyre.fun/me
- count: 256 / 280

```
two wallets on /me now: robinhood chain and solana, both custodial, both derived from the same seed on the server. deposit ETH to one, SOL to the other. solana trading on pyre is custodial only; to trade with your own key, trade on pump.fun.
```

### M3 · whose-fee

- purpose: the pump.fun creator fee is pump.fun's, changeable, re-routable; the terms say so
- visual: none (text post)
- alt text: n/a
- link: none; first reply: https://pyre.fun/legal/terms
- count: 265 / 280

```
pump.fun sets its creator fee, not us: 30 bps on the curve, a tiered share after graduation, changeable by them and re-routable under their community takeover process. the terms say so. a coin with no fees funds no build and no burn, on either chain.
```

### M4 · why-not-bridge

- purpose: founder voice on why PYRE stays on one chain
- visual: none (text post); or quote the pinned post
- alt text: n/a
- link: none; first reply: https://pyre.fun/pyre
- count: 229 / 280

```
why not bridge PYRE to solana? because then there would be two of it, and "which one is real" is a question we never want a holder to ask. one coin, one chain, one supply that only goes down. solana coins burn themselves instead.
```
