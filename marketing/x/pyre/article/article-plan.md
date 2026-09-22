# article figure plan

Article: `article.md`. Every figure is 1600×900 PNG in `figures/`. Diagrams 01–06 are rendered from `figures/src/*.html` with `node marketing/x/pyre/article/figures/src/render.mjs [name…]`; the one screenshot (09-launch) is captured from the live site with `node .tmp/shot.mjs <url> <out> --w=1600 --h=900 --wait=6000`.

Publishing order in X Articles: insert each figure at the position given, with the alt text as the image description and the caption (where given) as the visible caption. No screenshot may show a number the site does not show today; while the board is empty, the launch page is the only capture.

| # | file | section (placed after the heading) | alt text | visible caption | source |
|---|---|---|---|---|---|
| 1 | `figures/01-loop.png` | the loop | The Pyre loop: launch, fees, build, ship, earn, burn, with a return arc showing that any new fee relights a dormant app | one loop. revenue closes it. | `src/01-loop.html` |
| 2 | `figures/02-money.png` | where the money goes | Money-flow diagram: trading fees split 70% to the app then 60/25/15; app revenue split 85/10/5 | trading fees fund the build; app revenue funds the burn. pyre takes nothing from trades. | `src/02-money.html` |
| 3 | `figures/04-architecture.png` | what the agent builds, and what it cannot touch | Architecture: web and api share postgres and redis; a runner with thirteen BullMQ queues drives builds, chain workers and a five-minute reconcile pass | three services, thirteen queues, one chain. | `src/04-architecture.html` |
| 4 | `figures/03-attestation.png` | the attestation | Attestation calldata layout: 0x, four magic bytes 50 59 52 45, version byte 01, then a 32-byte sha256 of the sorted, comma-joined revenue-event ids, with a worked example | 37 bytes that tie a burn to the revenue that paid for it. the example ids are illustrative; the hash is real. | `src/03-attestation.html` |
| 5 | `figures/05-economics.png` | the numbers | Economics card: the trade-fee split, the revenue split and every threshold the loop runs on | the constants, from packages/shared in the public repo. | `src/05-economics.html` |
| 6 | `figures/06-audit.png` | engineering proof | Audit card: 62 of 68 production features pass, 6 blocked on treasury funding; 408 unit tests; 1 high and 5 medium review findings fixed | what passes, what is blocked, and why. | `src/06-audit.html` |
| 7 | `figures/09-launch.png` | how to launch | The launch page on pyre.fun: name the coin, describe the app in one sentence, stake 0.05 ETH | pyre.fun/launch | `https://pyre.fun/launch` |

## notes for the publisher

- Order in the article is 01, 02, 04, 03, 05, 06, 09 (the file numbers are by kind, not by position).
- The published article (2026-09-21) still carries the four demo-content screenshots (home, coin page, burn ledger, app store) and the earlier audit card. Edit the article on X: delete those four figures, replace figure 6 with the re-rendered `06-audit.png`, and paste the current "engineering proof", "what is live today" and "risks, plainly" sections from `article.md`. Production was purged the same day, so nothing on the site matches those captures any more.
- "Locked liquidity" was requested in the pons v2 section and left out: the repo describes graduation as liquidity moving into a Uniswap v4 pool but does not state that the LP is locked. Add it only if confirmed against pons documentation.
- The feature-audit figure of 62/68 is from the run recorded in `docs/go-live.md`; re-render the card whenever that number moves.
- The 60% build cut is described in the money section as half spendable budget, half model-credit funding, per `docs/economics.md`. Headline split stays 60/25/15.
- No emoji, no flame glyphs, no orange. All diagrams use the Obsidian Temper palette, Instrument Serif / Geist / Geist Mono via Google Fonts, the heat ramp rising from the bottom edge, and the brand lockup SVG.
- The article body says twice (live-today section, risks) that every number on the site is zero until a real coin earns it. Keep both lines until the first real launch, then rewrite them around the real figures.
- Figures 01–06 are regenerable; edit the HTML in `figures/src/` and re-run `render.mjs`.
