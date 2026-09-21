# Pyre — media wave: 3 videos + 8 image posts

Display name `Pyre`, handle @PyreFun. Same rules as `../posts/posts.md`: lowercase-declarative, no emoji, no price talk, buybacks are burns, never a contract address or a date, `PYRE` without the `$` (X auto-links the cashtag to an unrelated asset). Counts use X's weighting (URLs 23, most non-Latin symbols 2); `node src/count.mjs` recomputes them and checks every media file exists.

Everything here was captured from https://pyre.fun **after the purge** (0 apps, 0 fees, 0 burns) on the dark-only build, except where a frame says otherwise in-frame: the coin page (no coin exists, so it is the local mock API, stamped `mock data · no coin has launched yet`), the launch form input (stamped `example input · nothing is launched`), the Blockscout layout in the burn film (stamped `illustration · no burn tx exists yet`) and the component gallery (`/_ui` is dev-only, stamped `component gallery · dev build · sample values`).

Posting notes:
- Mornings get media (11:00 local); the existing text+card posts stay at 15:00 (Sep 22 → Oct 11, one per day). Never two media posts in one day.
- Videos: upload the 16:9 file as the post's media; the `-square` file is for a quote-repost or when X's feed crop looks wrong. Attach the `.srt` as captions on the two voice-over films (X → media → subtitles). The design film has no voice and needs no captions.
- Images: attach as given; two posts carry a second image (the diagram card). Paste the alt text per file.
- Links in the first reply, as before.
- **Throwaway prod user for the signed-in shots** (posts 05 and 08, plus the launch segment of the loop film): external wallet `0x676C8fD7dF4aE4A98f87eFd8de246d32b1585495`, custodial wallet `0x6d6772C9c2b5A5212f8540660868eed64d81be42`, user id `cmubm6e70000bog31i0suf7bd`. Delete that user row after posting. The deposit tray in post 05 shows that custodial address and its QR: it is a real derived address, so if the row is deleted **before** the post goes out, funds sent there would sit unowned — post first, delete after, or accept that the address is printed.

| # | when | media | file(s) |
|---|---|---|---|
| 01 | now (Sep 21, after the day-1 post) | video · the loop in 20 s | `loop.mp4` · `loop-square.mp4` · `loop-captions.srt` |
| 02 | Sep 22 · 11:00 | image · home, empty | `img/01-home-empty.png` |
| 03 | Sep 23 · 11:00 | image · /status | `img/06-status-live.png` |
| 04 | Sep 24 · 11:00 | image · ⌘K palette | `img/07-palette.png` |
| 05 | Sep 26 · 11:00 | image · /me deposit tray + wallet card | `img/05-me-deposit.png` · `img/09-wallet-flows.png` |
| 06 | Sep 27 · 11:00 | video · how a burn is verified | `burn.mp4` · `burn-square.mp4` · `burn-captions.srt` |
| 07 | Sep 28 · 11:00 | image · /burns, empty | `img/03-burns-empty.png` |
| 08 | Sep 29 · 11:00 | image · launch step 1 + $50 card | `img/02-launch-step1.png` · `img/10-budget-50.png` |
| 09 | Oct 3 · 11:00 | image · mobile home in a phone | `img/08-mobile-home.png` |
| 10 | Oct 8 · 11:00 | video · the design system | `design.mp4` · `design-square.mp4` |
| 11 | Oct 10 · 11:00 | image · /pyre, pre-launch | `img/04-pyre-prelaunch.png` |

Pairings with the 15:00 schedule: 01 leads into 03·revenue-burn; 05 sits before 06·agent-scope; 06 lands the morning of 04·attestation; 07 the morning of 17·verify-burn; 08 the morning of 16·launch-trays; 10 the morning of 15·design; 11 the morning of 18·live-next.

## 01 · loop-video

- when: post now
- media: `loop.mp4` (1920×1080, 23.6 s, VO) · alt square `loop-square.mp4` · captions `loop-captions.srt`
- alt text: screen recording with voice-over: the empty pyre.fun home, the launch form being typed into with an example coin, then a mock coin page walking the six-cell loop panel; ends on the pyre lockup and "supply falls because the app earned"
- link: none; first reply: https://pyre.fun
- count: 277 / 280

```
the loop, in twenty seconds.

launch a coin with one sentence. its trading fees pay an agent to build the app. the app earns, and 85% of that revenue buys the coin back and burns it.

the coin page in this clip is mock data. no coin has launched yet. the rest is the live site.
```

## 02 · home-empty

- when: Sep 22 · 11:00
- media: `img/01-home-empty.png`
- alt text: pyre.fun home on a dark canvas: eth burned 0.000, apps live 0, a dashed empty-feed panel reading "nothing has launched yet. be first." with a launch button, and "one loop. revenue closes it." below
- link: none; first reply: https://pyre.fun
- count: 244 / 280

```
live, zero coins. this is what an empty launchpad should look like.

no seeded apps, no placeholder charts, no fake volume. the feed says "nothing has launched yet" because nothing has.

the first coin to launch is the first thing on this page.
```

## 03 · status-live

- when: Sep 23 · 11:00
- media: `img/06-status-live.png`
- alt text: pyre.fun/status: pyre api operational; postgres 4 ms, redis 4 ms, robinhood chain rpc block 69,053,939 at 95 ms, queues 0 active 0 failed; network totals all zero
- link: none; first reply: https://pyre.fun/status
- count: 269 / 280

```
pyre.fun/status, read this morning: api operational, postgres and redis answering in 4 ms, robinhood chain rpc at block 69,053,939, queues 0 active and 0 failed.

apps live 0 · revenue $0.00 · eth burned 0.0000.

every number on the page is a probe, not a claim.
```

## 04 · palette

- when: Sep 24 · 11:00
- media: `img/07-palette.png`
- alt text: the command palette open over a dimmed home page: a search field "search coins, tickers, addresses…", a go-to list of launch a coin, app store, burn ledger, PYRE, your account, and a footer "paste a 0x address to jump to its coin"
- link: none
- count: 275 / 280

```
⌘K opens a palette on every page: launch, app store, burn ledger, PYRE, your account.

paste a 0x address and it jumps to that coin's page. type a name or a ticker and it searches.

small thing. but a launchpad you can drive from the keyboard is one that expects to be used.
```

## 05 · me-deposit

- when: Sep 26 · 11:00
- media: `img/05-me-deposit.png` + `img/09-wallet-flows.png`
- alt text (1): the account page dimmed behind an open deposit tray: a qr code, the custodial address on robinhood chain, "send ETH or USDG on robinhood chain only", and three bridge options: relay, arbitrum canonical bridge, across; balances behind read $0.00, 0.0000 ETH, 0.00 USDG
- alt text (2): diagram card "two ways in. same rules, different signer": four steps for google sign-in with a derived custodial wallet, four steps for signing in with your own wallet via an eip-191 challenge, and a footer on gas-free eip-3009 USDG payments relayed by the treasury
- link: none; first reply: https://pyre.fun/me
- count: 263 / 280

```
your account on pyre, signed in with a wallet nobody has funded: $0.00, 0.0000 ETH, 0.00 USDG.

deposit opens a robinhood chain address with a qr and three bridges.

google sign-in gets a wallet pyre derives and signs for. your own wallet signs everything itself.
```

## 06 · burn-video

- when: Sep 27 · 11:00
- media: `burn.mp4` (1920×1080, 29.6 s, VO) · alt square `burn-square.mp4` · captions `burn-captions.srt`
- alt text: motion graphic with voice-over: 37 calldata bytes typing out, 50 59 52 45 then 01 then a 32-byte hash; three example revenue event ids sorted, joined and hashed to match; a blockscout-style layout of a burn tx and an attestation tx marked as an illustration; the live empty burn ledger; "no burn has happened yet"
- link: none; first reply: https://pyre.fun/burns
- count: 272 / 280

```
how a burn is verified.

every burn ends with an attestation tx: calldata 0x5059524501, then sha256 of the revenue event ids that paid for it. on blockscout, burn() lowers totalSupply and nothing moves to a wallet.

no burn has happened yet; the explorer frames are drawn.
```

## 07 · burns-empty

- when: Sep 28 · 11:00
- media: `img/03-burns-empty.png`
- alt text: pyre.fun/burns: eth burned 0.000, buybacks 0, coins 0, last burn dash; a dashed empty panel "no burns yet: the first buyback fires once any app on pyre has earned $5"; a note that burns call burn() and lower totalSupply
- link: none; first reply: https://pyre.fun/burns
- count: 269 / 280

```
the burn ledger, live: 0.000 ETH burned, 0 buybacks, 0 coins.

the first row appears when any app on pyre has earned $5. it will carry a swap tx, a burn tx and an attestation tx you can open on blockscout.

an empty ledger is not a bug. it is the honest starting state.
```

## 08 · launch-step1

- when: Sep 29 · 11:00
- media: `img/02-launch-step1.png` + `img/10-budget-50.png`
- alt text (1): the launch page signed in, step 01 coin of three: name and ticker fields, an image picker, a "what should the agent build?" textarea, a "draft the agent brief" button, and a live preview card on the right showing $TICKER, market cap $0.00, fees to agent $0.00, burned 0.00%
- alt text (2): diagram card "nothing builds until the coin has earned $50 of budget": where budget comes from, then a rail with $0 launch, $10 iteration minimum, $50 first build, $5 revenue for the first buyback, and the five deploy gates
- link: none; first reply: https://pyre.fun/launch
- count: 272 / 280

```
launch, step one: a name, a ticker, an image, one sentence on what the agent should build.

the card on the right is what the feed shows the moment the coin exists. zero everything, read from the chain.

the example text in the form is a placeholder. nothing was launched.
```

## 09 · mobile-home

- when: Oct 3 · 11:00
- media: `img/08-mobile-home.png`
- alt text: a phone outline on obsidian showing pyre.fun at 390 wide: apps live 0, the empty feed "nothing has launched yet. be first.", a launch button, a bottom tab bar home apps burns me; caption "pyre.fun on a phone · 390 wide · live · nothing has launched yet"
- link: none
- count: 231 / 280

```
pyre.fun at 390 wide. one column, the same empty feed, a launch button that stays under your thumb.

nothing has launched yet, so that is what the phone says too. no app-store screenshots of things that do not exist.
```

## 10 · design-video

- when: Oct 8 · 11:00
- media: `design.mp4` (1920×1080, 28.6 s, text overlays, no VO) · alt square `design-square.mp4`
- alt text: silent film with text overlays over the component gallery: the title "build. earn. burn.", the colour tokens and the six-step heat ramp, the type scale in instrument serif and geist, four supply kilns hollowing a layer when "burn 10%" is clicked, rolling number counters and a heat gauge; ends on the pyre lockup
- link: none; first reply: https://github.com/realdoomsman/pyre/blob/main/marketing/brand/pyre/BRAND.md
- count: 278 / 280

```
the design system, in under 30 seconds.

heat, not flame: one accent, a ramp from violet to cobalt to white, instrument serif for the voice, geist for the ui, geist mono for every number. the supply kiln hollows a layer per burn.

the gallery in this clip runs on sample values.
```

## 11 · pyre-prelaunch

- when: Oct 10 · 11:00
- media: `img/04-pyre-prelaunch.png`
- alt text: pyre.fun/pyre: the PYRE page with a "not launched yet" band, contract "not launched yet", chain robinhood chain 4663, venue PONS v2 curve then uniswap v4; a card "earmarked so far $0.00"; a ledger accrued $0, burned $0, pending $0
- link: none; first reply: https://pyre.fun/pyre
- count: 277 / 280

```
pyre.fun/pyre today: not launched yet.

25% of every claimed creator fee and 10% of every sale accrue to a ledger that buys and burns PYRE once it exists. no pre-sale, no allocation, no whitelist.

PYRE launching soon. no address exists. anyone posting one is not us.
```

## how these were made

- `node src/capture.mjs` records the live pages as 30 fps frame sequences (coin page and `/_ui` from the local vite + mock API on :5181 and :8787; `build/session.json` signs the launch segment in).
- `node src/audio.mjs <film>` synthesises the voice (edge-tts), lays out the timeline, writes the `.srt`, and builds the music bed and sfx from `../video/src/music.mjs` and `../video/src/sfx.mjs`.
- `node src/render.mjs <film> [--sq]` renders `src/stage.html` frame by frame; `node src/audio.mjs <film> --mux` muxes.
- `node src/shots.mjs` takes the eight screenshots (and frames the mobile one); `src/cards.html` is the two diagram cards.
- `node src/qa.mjs` prints ffprobe facts and writes a frame every 5 s plus contact sheets to `build/qa/`.
- `node src/count.mjs` recounts this file.
