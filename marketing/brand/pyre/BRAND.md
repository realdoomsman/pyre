# Pyre — identity v2 "Obsidian Temper"

coins that build apps. revenue *burns* them.

Every Pyre coin is a PONS v2 launch on Robinhood Chain. Its creator fees fund an AI agent that builds the app the coin describes; the app's revenue buys the coin back and burns it. The identity shows fire only through its consequence — supply shrinking, metal tempering — never as a flame.

## Files

| File | Use |
|---|---|
| `mark.svg` | The mark. Colour, on any dark surface. |
| `mark-mono-light.svg` / `mark-mono-dark.svg` | Single-colour mark (white / black) for embossing, favicons in mono contexts, third-party listings that flatten colour. |
| `wordmark.svg` / `wordmark-on-light.svg` | "Pyre" in Instrument Serif, outlined (no font dependency). Ink / near-black. |
| `lockup.svg` / `lockup-on-light.svg` | Mark + wordmark, horizontal. |
| `favicon.svg` | The mark (same geometry, separate ids so it can be inlined next to `mark.svg`). |
| `pfp.png` 1024² | X avatar: the mark on obsidian, heat spilling onto the floor. |
| `pfp-alt.png` 1024² | Alternative avatar: wordmark only, the whole circle is the tempered tile. |
| `banner.png` 1500×500 | X header. Bottom-left 420×180 kept empty for the avatar; `banner-safe-preview.png` proves it. |
| `og.png` 1200×630 | Share card. Stats are `—` placeholders until the API renders live ones. |
| `apple-touch-icon.png` 180² | Full-bleed tile on obsidian (iOS masks its own corners). |
| `icon-192.png` / `icon-512.png` | PWA icons, transparent corners. |
| `*.html` | Sources for every PNG. `proof.html` is the size/contrast proof sheet. |
| `tools/gen-svg.mjs`, `tools/render.mjs` | Regenerate SVGs / re-render PNGs (commands at the bottom). |

## 1. Rationale

**Heat, not flame.** A flame glyph says "hot coin"; every launchpad has one. Pyre's mechanism is slower and more certain: revenue arrives, supply leaves. The visual language is therefore *tempering* — an obsidian block just pulled from a kiln, its lower edge still glowing — and the heat is the wrong colour for fire on purpose. Violet → cobalt → white is hotter than orange. It reads as engineered heat, not a campfire.

**One object, one edge.** The mark is a rounded square (the tile every coin card, app icon and ledger row is built from) whose bottom edge carries the heat ramp. Everything else in the system reuses that gesture: the heat rises from the bottom of a card, a page, an avatar, a share card. The mono mark keeps the same silhouette and shows the boundary as a curved hairline — the temper line on a blade.

**Serif, lowercase, numbers.** Instrument Serif at display sizes gives the brand its voice: quiet, editorial, sure of itself. Geist carries the UI; Geist Mono carries every number, hash and label, because on Pyre the numbers are the argument.

Explicitly rejected: orange/ember palettes, lime, flame glyphs, emoji, wide grotesk wordmarks, "web3 gradients" (magenta→cyan).

## 2. Palette

One theme: dark, "Obsidian Temper". There is no light mode — the app store, the docs and the legal pages sit on the same canvas as everything else.

| Token | Hex | Use |
|---|---|---|
| `canvas` | `#0A0A0C` | page / avatar / banner background |
| `surface` | `#121215` | cards, panels |
| `raised` | `#18181D` | hover, popovers, the tile body |
| `line` | `rgba(255,255,255,.07)` | hairlines, dividers |
| `ink` | `#F3F2EE` | primary text, line-art |
| `ink-2` | `#9B9891` | secondary text, mono labels |
| `ink-3` | `#8A877F` | tertiary text, ash / dormant, disabled |
| `accent` | `#9D8CFF` | tempered violet — links, the emphasised word, focus |
| `accent-strong` | `#7A66F5` | buttons, active states |
| `build` | `#3E8BFF` | agent / build activity |
| `earn` | `#4FD1A6` | revenue in |
| `burn` | `#FF4D6D` | supply out, destructive |
| `warn` | `#E5C15C` | caution only |
| `white-hot` | `#E9F1FF` | the hottest point; peaks of heat animations |

**Heat ramp** (cold → hot): `#1C1B2E → #3B2F7A → #7A66F5 → #3E8BFF → #9CD2FF → #E9F1FF`. Always vertical, always rising from the bottom edge of the thing it heats. Never horizontal, never as a text fill.

Contrast on `canvas`: `ink` 17.7:1, `accent` 7.2:1, `ink-2` 6.9:1, `ink-3` 5.5:1 (4.9:1 on `raised` — still AA at 12px).

## 3. Type

| Role | Face | Setting |
|---|---|---|
| Display / taglines / hero numbers | **Instrument Serif** 400 | `letter-spacing:-0.02em`, `line-height:1.02–1.06`. *Italic for exactly one emphasised word* per line (`burns`). |
| UI, prose | **Geist Sans** 400 / 500 / 600 | `font-variant-numeric: tabular-nums`. Captions 600. |
| Numbers, addresses, hashes, ledger, labels | **Geist Mono** 400 / 500 | Labels 12–14px uppercase `letter-spacing:.04–.06em`. Values never uppercase. |

Google Fonts: `https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap`

Never: bold Instrument Serif (it doesn't exist; don't fake it), all-caps serif, tracking the serif wide, Geist as a display face above 40px.

## 4. Mark

**Construction.** Square, corner radius 22% of the side. Body: `raised` with a 6% diagonal sheen from the top-left. Heat: vertical ramp starting at 50% height, reaching `white-hot` at the bottom edge, with a wide elliptical core centred on the bottom edge and a 2.8% white-hot lip. A single curved temper line (white-hot at 13%) sits at 46–60% height. Optional 1.5-unit inner edge highlight for large sizes.

**Wordmark.** "Pyre", Instrument Serif Regular, `-0.02em`, font kerning on, outlined to paths. Never re-typeset it in the browser for logo use — use the SVG.

**Lockup.** Mark height = 1.12 × cap height of the wordmark; the mark's bottom (hot) edge sits on the baseline; gap = 0.36 × mark height. `y`'s descender may hang below the mark — that is intended.

**Clear space.** Minimum clear space on all sides = 0.5 × mark height (mark alone) or the height of the "P" (lockup). Nothing crosses the heat edge.

**Minimum size.** Mark 16px (favicon; the ramp reads as a lit base). Lockup 20px tall. Wordmark alone 14px. Mono marks 12px.

**Backgrounds.** Colour mark on `canvas`, `surface`, `raised`, or photography darker than 20% luminance. On paper, mid-tone or busy backgrounds use a mono mark.

**Don't.**
- Don't rotate it, tilt it, or put the heat anywhere but the bottom edge.
- Don't recolour the ramp (no orange, no lime, no magenta, no brand colours of chains/partners).
- Don't add a flame, spark, ember, coin, rocket or emoji to or near it.
- Don't outline the colour mark or add a drop shadow; the floor glow in `pfp.png` is the only permitted spill, and it stays under the tile.
- Don't put text inside the tile.
- Don't stretch the corner radius to a circle or a pill.
- Don't set "PYRE" in caps as a wordmark. It is `Pyre` (wordmark, prose) and `$PYRE` (ticker, mono).

## 5. Voice

Lowercase, declarative, numbers over adjectives. Say what happened and show the hash.

- Yes: `app #14 earned $1,240 this week. bought back 3.1% of supply. burned. tx ↓`
- Yes: `12 apps live · $8,410 revenue · 41.2m coins burned`
- No: hype, exclamation marks, emoji, "huge", "massive", "incoming".

Rules:
- **No price talk.** No targets, no "up only", no "cheap", no charts-with-arrows. Market cap is a fact we display, never a claim we make.
- **Buybacks are burns, never distributions.** Nothing is paid out to holders. Say *supply falls*, *burned*, *bought back and burned*. Never *yield*, *dividend*, *revenue share*, *passive income*, *rewards*.
- **Coin, not token** in prose. Contract addresses are always printed in full, in mono.
- **No `$PYRE` cashtag on X yet.** X auto-links `$PYRE` to an unrelated asset; write `PYRE` until our coin is live and the mapping is verified.
- **Apps are the point.** Lead with what the app does and what it earned. The coin is the consequence.
- Every post that names an amount links the tx or the app. If it can't be verified on Blockscout, don't post it.
- `not financial advice` appended to anything that mentions a market cap or a price.

Words: launch, build, earn, burn, budget, supply, holders, app, ship, dormant, relight, heat.
Not: token, invest, profit, APY, moon, degen, alpha, gem.

## 6. X profile

- **Name:** `Pyre`
- **Bio (151/160):** `coins that build apps. fees pay an AI to build the app. app revenue buys the coin back and burns it. every coin is a PONS v2 launch on Robinhood Chain.`
- **Location:** `Robinhood Chain`
- **Website:** `pyre.fun`
- **Avatar:** `pfp.png` (or `pfp-alt.png`). **Header:** `banner.png`.
- Pinned: the $PYRE launch post once live; until then the "how it works" thread (Wave 5).

## 7. Regenerate

From the repo root, Windows, Chrome installed at the default path (`CHROME=` overrides):

```
# SVGs (once: cd .tmp/brand && npm i opentype.js@1.3.4 && curl -sLO https://github.com/Instrument/instrument-serif/raw/main/fonts/ttf/InstrumentSerif-Regular.ttf)
node marketing/brand/pyre/tools/gen-svg.mjs

# all PNGs, or a subset by name
node marketing/brand/pyre/tools/render.mjs
node marketing/brand/pyre/tools/render.mjs banner og
```

Equivalent one-liner per file (what `render.mjs` runs):

```
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=1500,500 --virtual-time-budget=5000 --screenshot=C:/tech/ship/marketing/brand/pyre/banner.png file:///C:/tech/ship/marketing/brand/pyre/banner.html
```

Sizes: `pfp` 1024×1024, `pfp-alt` 1024×1024, `banner` 1500×500, `banner-safe-preview` 1500×500, `og` 1200×630, `apple-touch-icon` 180×180, `icon-192` / `icon-512` add `--default-background-color=00000000` for transparent corners. `proof.html` renders at 1400×1100.
