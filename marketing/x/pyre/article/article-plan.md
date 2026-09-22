# article figure plan

Article: `article.md`. Every figure is 1600×900 PNG in `figures/`. Diagrams 01–06 are rendered from `figures/src/*.html` with `node marketing/x/pyre/article/figures/src/render.mjs [name…]`; the one screenshot (09-launch) is captured from the live site with `node .tmp/shot.mjs <url> <out> --w=1600 --h=900 --wait=6000`.

Publishing order in X Articles: insert each figure at the position given, with the alt text as the image description and the caption (where given) as the visible caption. No screenshot may show a number the site does not show today; while the board is empty, the launch page is the only capture.

| # | file | section (placed after the heading) | alt text | visible caption | source |
|---|---|---|---|---|---|
| 1 | `figures/01-loop.png` | the loop | The Pyre loop: launch, fees, build, ship, free app, PYRE burn, with a return arc showing that any new fee relights a dormant app | one loop. fees close it. | `src/01-loop.html` |
| 2 | `figures/02-money.png` | where the money goes | Money-flow diagram: the 1% trade fee, 70% to the app wallet, then 60% build, 25% PYRE burn, 15% launcher; 25% of every coin flows into one PYRE burn | trading fees fund the build and the burn. pyre takes nothing from trades and nothing from apps. | `src/02-money.html` |
| 3 | `figures/04-architecture.png` | what the agent builds, and what it cannot touch | Architecture: web and api share postgres and redis; a runner with thirteen BullMQ queues drives builds, chain workers and a five-minute reconcile pass | three services, thirteen queues, one chain. | `src/04-architecture.html` |
| 4 | `figures/03-attestation.png` | the attestation | Attestation calldata layout: 0x, four magic bytes 50 59 52 45, version byte 01, then a 32-byte sha256 of the sorted, comma-joined ids of the fee entries the burn consumed, with a worked example | 37 bytes that tie a burn to the fees that paid for it. the example ids are illustrative; the hash is real. | `src/03-attestation.html` |
| 5 | `figures/05-economics.png` | the numbers | Economics card: the trade-fee split, the PYRE burn and every threshold the loop runs on | the constants, from packages/shared in the public repo. | `src/05-economics.html` |
| 6 | `figures/06-audit.png` | engineering proof | Audit card: the production feature audit, the unit suite and the independent review findings, with the checks blocked on treasury funding | what passes, what is blocked, and why. | `src/06-audit.html` |
| 7 | `figures/09-launch.png` | how to launch | The launch page on pyre.fun: name the coin, describe the app in one sentence, stake 0.05 ETH | pyre.fun/launch | `https://pyre.fun/launch` |

## notes for the publisher

- Order in the article is 01, 02, 04, 03, 05, 06, 09 (the file numbers are by kind, not by position).
- The published article (2026-09-21) describes in-app USDG payments and an app-coin buyback that no longer exist (apps are free since 2026-09-22; only PYRE is bought and burned, from the 25% fee share). Edit the article on X: replace the whole body with the current `article.md` and every figure with the re-rendered PNGs. Production was purged on 2026-09-21, so nothing on the site matches the earlier captures either.
- "Locked liquidity" was requested in the pons v2 section and left out: the repo describes graduation as liquidity moving into a Uniswap v4 pool but does not state that the LP is locked. Add it only if confirmed against pons documentation.
- The feature-audit card must be re-rendered from the first post-cutover run recorded in `docs/go-live.md`; the 62/68 count predates the removal of the two payment checks and must not be published again.
- The 60% build cut is described in the money section as half spendable budget, half model-credit funding, per `docs/economics.md`. Headline split stays 60/25/15.
- No emoji, no flame glyphs, no orange. All diagrams use the Obsidian Temper palette, Instrument Serif / Geist / Geist Mono via Google Fonts, the heat ramp rising from the bottom edge, and the brand lockup SVG.
- The article body says twice (live-today section, risks) that every number on the site is zero until a real coin earns it. Keep both lines until the first real launch, then rewrite them around the real figures.
- Figures 01–06 are regenerable; edit the HTML in `figures/src/` and re-run `render.mjs`.
