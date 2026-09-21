# article figure plan

Article: `article.md` (2,750 prose words; ~3,290 including tables, code blocks and alt text). Every figure is 1600×900 PNG in `figures/`. Diagrams 01–06 are rendered from `figures/src/*.html` with `node marketing/x/pyre/article/figures/src/render.mjs [name…]`; screenshots 07–11 are captured from the live site with `node .tmp/shot.mjs <url> <out> --w=1600 --h=900 --wait=6000`.

Publishing order in X Articles: insert each figure at the position given, with the alt text as the image description and the caption (where given) as the visible caption. Screenshots of demo content MUST keep the demo notice in the caption.

| # | file | section (placed after the heading) | alt text | visible caption | source |
|---|---|---|---|---|---|
| 1 | `figures/01-loop.png` | the loop | The Pyre loop: launch, fees, build, ship, earn, burn, with a return arc showing that any new fee relights a dormant app | one loop. revenue closes it. | `src/01-loop.html` |
| 2 | `figures/02-money.png` | where the money goes | Money-flow diagram: trading fees split 70% to the app then 60/25/15; app revenue split 85/10/5 | trading fees fund the build; app revenue funds the burn. pyre takes nothing from trades. | `src/02-money.html` |
| 3 | `figures/04-architecture.png` | what the agent builds, and what it cannot touch | Architecture: web and api share postgres and redis; a runner with thirteen BullMQ queues drives builds, chain workers and a five-minute reconcile pass | three services, thirteen queues, one chain. | `src/04-architecture.html` |
| 4 | `figures/03-attestation.png` | the attestation | Attestation calldata layout: 0x, four magic bytes 50 59 52 45, version byte 01, then a 32-byte sha256 of the sorted, comma-joined revenue-event ids, with a worked example | 37 bytes that tie a burn to the revenue that paid for it. the example ids are illustrative; the hash is real. | `src/03-attestation.html` |
| 5 | `figures/05-economics.png` | the numbers | Economics card: the trade-fee split, the revenue split and every threshold the loop runs on | the constants, from packages/shared in the public repo. | `src/05-economics.html` |
| 6 | `figures/06-audit.png` | engineering proof | Audit card: 58 of 68 production features pass, 6 blocked on treasury funding, 3 skipped, 1 pending redeploy; 408 unit tests; perimeter check 27 of 28; 1 high and 5 medium review findings fixed | what passes, what is blocked, and why. | `src/06-audit.html` |
| 7 | `figures/07-home.png` | what is live today, and what launches next | The pyre.fun home page: coin grid ranked by revenue and the live burn feed. The three coins shown are seeded demo content used to build and verify the platform; the revenue and burn figures are not real | pyre.fun today. the three coins are seeded demo content; the numbers are placeholders. | `https://pyre.fun` scrolled 415px past the build-log hero (`--eval="window.scrollTo(0,415)"`) |
| 8 | `figures/08-coin.png` | what is live today (after the demo-content paragraph) | A coin page on pyre.fun (demo content): ticker, market cap, holders, burned percentage, graduation progress and the trade panel. The figures are seeded demo values, not real activity | a coin page. demo content; not real activity. | `https://pyre.fun/c/inboxzero` |
| 9 | `figures/10-burns.png` | what is live today (after the coin page) | The burn ledger on pyre.fun (demo content): every buyback with its coins burned, percentage of supply, ETH spent, revenue source, burn tx and attestation tx. Rows shown are seeded demo data | the burn ledger. every row carries a burn tx and an attestation tx. rows shown are seeded demo data. | `https://pyre.fun/burns` |
| 10 | `figures/11-apps.png` | what is live today (after the burn ledger) | The app store on pyre.fun (demo content), the light "ash paper" surface, ranked by revenue rather than volume. The listed apps and figures are seeded demo data | the app store, ranked by dollars earned. demo content. | `https://pyre.fun/apps` |
| 11 | `figures/09-launch.png` | how to launch | The launch page on pyre.fun: name the coin, describe the app in one sentence, stake 0.002 ETH | pyre.fun/launch | `https://pyre.fun/launch` |

## notes for the publisher

- Order in the article is 01, 02, 04, 03, 05, 06, 07, 08, 10, 11, 09 (the file numbers are by kind, not by position).
- The home page hero is a live build log for a demo coin whose latest entries are reviewer rejections and an upstream API error; the capture is scrolled past it on purpose. If a cleaner hero is wanted, recapture after the demo rows are purged.
- "Locked liquidity" was requested in the pons v2 section and left out: the repo describes graduation as liquidity moving into a Uniswap v4 pool but does not state that the LP is locked. Add it only if confirmed against pons documentation.
- The "1 pending redeploy" audit item is `workers.reconcile_reports_no_drift` per Main; the card and the prose describe it as a stale runner build that has since been redeployed.
- The 60% build cut is described in the money section as half spendable budget, half model-credit funding, per `docs/economics.md`. Headline split stays 60/25/15.
- No emoji, no flame glyphs, no orange. All diagrams use the Obsidian Temper palette, Instrument Serif / Geist / Geist Mono via Google Fonts, the heat ramp rising from the bottom edge, and the brand lockup SVG.
- Every screenshot caption that shows a number carries the demo-content notice. The article body also says so twice (live-today section, risks).
- Figures 01–06 are regenerable; edit the HTML in `figures/src/` and re-run `render.mjs`.
