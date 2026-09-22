# Pyre — media wave: 4 screenshot posts (live-platform set, 2026-09-22)

Display name `Pyre`, handle @PyreFun. Same rules as `../posts/posts.md`: lowercase-declarative, no emoji, no price talk, buybacks are burns never distributions, "coin" not "token", `PYRE` without the `$`. Counts use X's weighting (URLs and bare domains 23, most non-Latin symbols 2); `node src/count.mjs` recomputes them and checks every media file exists (a `FRESH:` row has no file yet and is reported as missing until it is captured).

**Every file in this directory is stale.** `loop.mp4`, `burn.mp4`, `design.mp4` (and their square cuts and captions) and all ten `img/*.png` were captured on 2026-09-21 against the pre-launch, pre-cutover site: empty feeds, "nothing has launched yet", "revenue closes it", a mock coin page, a drawn blockscout frame, USDG balances, a supply kiln. None of them may be posted. Every media row below is `FRESH:` a capture of the live site as it is today; take it the morning it posts so the numbers in the shot match or exceed the copy.

Posting notes:
- Mornings get media (11:00 local); the cards in `../posts/posts.md` stay at 15:00. Never two media posts in one day, never more than two posts a day.
- Capture at 1600×900, dark build, no browser chrome, signed out unless the row says otherwise. Paste the alt text per file after checking it against what was actually captured.
- Links in the first reply, as before.
- The PYRE contract address appears in post 04 and nowhere else.

| # | day | when | media | pairs with (15:00) |
|---|---|---|---|---|
| 01 | 1 | Sep 23 · 11:00 | FRESH: pyre.fun home, live | 01 · loop |
| 02 | 2 | Sep 24 · 11:00 | FRESH: pyre.fun/pyre, live | 02 · pyre-burn |
| 03 | 4 | Sep 26 · 11:00 | FRESH: basket.pyre.fun | 04 · build-gate |
| 04 | 7 | Sep 29 · 11:00 | FRESH: pyre.fun/burns + one burn tx on blockscout | 07 · attestation |

## 01 · home-live

- day: 1 · Sep 23 · 11:00
- media: FRESH: `img/11-home-live.png`, pyre.fun home signed out, the stat strip and the feed with the live coins and the apps that shipped
- alt text: pyre.fun home on a dark canvas: the stat strip with eth burned, apps live and agent-hours today, then the feed of live coins with their build state
- link: none; first reply: https://pyre.fun
- count: 237 / 280

```
pyre.fun, one day in: 67 launches, 6 coins live, 3 apps deployed, 3 building right now, 14 PYRE burns.

nothing seeded, nothing placeholder. the feed shows what shipped and what is still building, in the order it happened.
```

## 02 · pyre-page

- day: 2 · Sep 24 · 11:00
- media: FRESH: `img/12-pyre-live.png`, pyre.fun/pyre with the contract address, venue (pons v2 curve, graduated to uniswap v4), and the burn ledger totals
- alt text: pyre.fun/pyre: the PYRE page with its contract address on robinhood chain 4663, venue pons v2 graduated to uniswap v4, and a ledger showing PYRE bought and burned so far
- link: none; first reply: https://robinhoodchain.blockscout.com/address/0xc8488bE2e4f430420A364E64f4D8af428b74D903
- count: 278 / 280

```
PYRE is live on robinhood chain (4663).

0xc8488bE2e4f430420A364E64f4D8af428b74D903

launched on pons v2 from the founder's own wallet, treasury as creator-fee recipient. graduated to the uniswap v4 pool the same day.

this is the only address. anyone posting another is not us.
```

## 03 · basket

- day: 4 · Sep 26 · 11:00
- media: FRESH: `img/13-basket.png`, basket.pyre.fun as deployed: a weighted basket of real pyre coins with its equity curve and per-leg trade links
- alt text: basket.pyre.fun: a weighted basket of pyre coins with exact-cent sizing per leg, an hourly equity curve, and one trade link per coin, in pyre's dark design system
- link: none; first reply: https://basket.pyre.fun
- count: 271 / 280

```
basket: launched 05:39 utc. first fee claimed 05:40. first build started 05:46. v1 live at 06:44.

65 minutes from one sentence to basket.pyre.fun: weighted baskets of real pyre coins, exact-cent sizing, an hourly equity curve, a trade link per leg. 120+ holders.
```

## 04 · burns-ledger

- day: 7 · Sep 29 · 11:00
- media: FRESH: `img/14-burns-live.png`, pyre.fun/burns with the ledger rows, and `img/15-burn-tx.png`, one burn tx on robinhoodchain.blockscout.com showing the totalSupply drop. Fallback if only one image: `../posts/visuals/17-verify-burn.png` is still accurate and may be the second image.
- alt text (1): pyre.fun/burns: eth burned and burn count at the top, then the ledger with one row per burn, each linking a swap tx, a burn tx and an attestation tx
- alt text (2): blockscout page of one PYRE burn transaction: a call to burn(), totalSupply reduced by the burned amount, no transfer to any wallet
- link: none; first reply: https://pyre.fun/burns
- count: 270 / 280

```
the burn ledger, live: 14 burns, 0.141 ETH in, 1,372,423 PYRE out of supply.

burns run every 10 minutes once $5 of the 25% fee share has pooled. since graduation they buy through the uniswap v4 pool. every row links its swap, its burn and its attestation on blockscout.
```

## how the stale media was made (for re-rendering later)

- `node src/capture.mjs` records the live pages as 30 fps frame sequences (coin page and `/_ui` from the local vite + mock API on :5181 and :8787; `build/session.json` signs the launch segment in).
- `node src/audio.mjs <film>` synthesises the voice (edge-tts), lays out the timeline, writes the `.srt`, and builds the music bed and sfx from `../video/src/music.mjs` and `../video/src/sfx.mjs`.
- `node src/render.mjs <film> [--sq]` renders `src/stage.html` frame by frame; `node src/audio.mjs <film> --mux` muxes.
- `node src/shots.mjs` takes the screenshots (and frames the mobile one); `src/cards.html` is the two diagram cards.
- `node src/qa.mjs` prints ffprobe facts and writes a frame every 5 s plus contact sheets to `build/qa/`.
- `node src/count.mjs` recounts this file.
- Before any film is re-rendered: `src/films.mjs` and `src/stage.html` still narrate "no coin has launched yet", "no burn has happened yet", a mock coin page and a supply kiln. Rewrite the scripts against the live coin page, a real burn row and the live basket app first.
