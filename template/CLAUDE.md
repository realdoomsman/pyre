# Working on this app

This is a **Pyre app**: a Vite + React 19 + Tailwind v4 front end plus server functions, hosted by
the Pyre platform. The platform owns identity and storage. You own the product. The app is **free
to use**: there is no checkout, no subscription, no per-call price and no ads — never add any.

## Hard rules — a diff that breaks any of these is rejected by the reviewer

1. **Never write auth, wallet or signature code.** No `viem`, `ethers`, `wagmi`, no
   `window.ethereum`, no key handling, no transaction building, no "connect wallet" UI of your own.
   The platform holds each user's Robinhood Chain wallet and reads holder balances for you. Use
   `@pyre/app-sdk`: `<LoginButton/>`, `usePyre()`, `<HolderGate/>`.
2. **Never add payments.** No prices, paywalls, tips, credits, subscriptions or ad slots — not in
   the UI, not in `functions/`, not in the manifest. The only thing you may gate on is holding the
   app's coin (`<HolderGate/>`, `holderOnly` functions).
3. **Never call the network.** `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and any
   third-party API are forbidden — the app is served under `default-src 'self'` and calls will fail.
   All server work goes through `ship.fn(name, input)`.
4. **Never add `<script src>`, `eval`, `new Function` or `dangerouslySetInnerHTML`.** `script-src` is
   `'self'`; injected scripts break the page.
5. **Never add a dependency that talks to the internet at runtime**, and prefer adding no
   dependency at all. `eslint.config.js` enforces rules 3–4 and the design rules below; do not weaken
   or disable it.
6. **`pyre.manifest.json` must stay accurate.** Every function you call must be listed in
   `functions` (`name`, `auth`, `holderOnly`), `holderTier.minHoldTokens` must be set when you use
   `<HolderGate/>`, and the `name` must equal the page's `<h1>` (`tests/smoke.spec.ts` checks this).
7. **Server logic lives in `functions/*.js`** and may only use the injected `ship` object. No
   imports, no `require`, no Node APIs, no network — QuickJS, 64MB, 5s CPU, result JSON ≤ 1MB.
   `ship.input` (body, `{}` when empty), `ship.user` (always an object
   `{id: string|null, wallet: string|null, isHolder: boolean}` — `id` is `null` when anonymous),
   `ship.kv.get/set/del(key)` (app scope, key `^[A-Za-z0-9_.:-]{1,120}$`, value ≤ 64KB),
   `ship.llm(prompt, {maxTokens})` (≤ 1024 tokens, billed to the build budget),
   `ship.fetch(url, body?)` (another Pyre app's `/_pyre/fn/<name>` only).
8. **Run `npm run build` and `npm test` before you finish.** Both must pass. Fix what they report;
   never leave the tree broken and never delete a test to make it pass.

## Design system — mandatory, no exceptions

Every app on Pyre looks like Pyre. The theme lives in `src/index.css` and the components in
`src/components/`; both are the product's visual language, not a starting point to restyle.

- **One dark theme.** Page `bg` `#0A0A0C`, cards `surface` `#111114` with a 1px `border` `#1F1F24`
  and an 8px radius (`rounded-card`), text `ink` `#F3F2EE` (`ink-muted`, `ink-faint` for
  secondary copy). No light mode, no `prefers-color-scheme` switch.
- **One accent.** `violet` `#9D8CFF` (hover `violet-hover` `#7A66F5`, tint `violet-soft`). The heat
  ramp `heat-1…heat-6` (`#1C1B2E → #3B2F7A → #7A66F5 → #3E8BFF → #9CD2FF → #E9F1FF`) is for charts,
  progress and intensity only. `danger` `#E5484D` is for error messages only.
- **Type.** `font-display` (Instrument Serif) for `h1`–`h3` and display numbers, `font-sans`
  (Geist) for everything else, `font-mono tabular-nums` (Geist Mono) for numbers, tickers, ids and
  code. The fonts are wired in `index.html`; do not add others.
- **Components.** `Button` (violet primary with ink text; `secondary`, `ghost`), `Card`, `Input`,
  `Chip`, `EmptyState`, `PageHeader` from `src/components`. Compose them; add new components in the
  same folder with the same tokens instead of hand-styling `div`s. Every async surface needs a
  loading, empty (`<EmptyState/>`) and error state.
- **Forbidden:** orange, amber, lime, emerald, green, yellow or any warm colour; gradients on
  buttons; white buttons; emoji or symbol glyphs of any kind (no fire, sparkles, checkmarks,
  arrows-as-icons);
  flame/fire imagery; pill (`rounded-full`) or `rounded-2xl` cards; Tailwind's default palette
  (`bg-blue-500`, `text-gray-400`, `bg-white`, …). The palette is reset in `src/index.css`, so
  those classes render nothing, and `npm run lint` fails on emoji and off-palette class names.

## Layout

```
index.html              page shell + fonts (the platform injects /_pyre/env.js into <head>)
src/main.tsx            mounts <PyreProvider> — do not remove it
src/App.tsx             your app
src/index.css           `@import "tailwindcss";` + the Pyre theme tokens
src/components/         Button, Card, Input, Chip, EmptyState, PageHeader, cx()
functions/<name>.js     server functions, `export default async (input, ship) => …`
pyre.manifest.json      declared functions, holder tier
tests/smoke.spec.ts     Playwright smoke test (keep it passing, extend it)
dev/pyre-local-host.ts  local stand-in for /_pyre/* so dev/preview/tests run offline
```

`dist/` + `functions/` + `pyre.manifest.json` are what the platform deploys.

## The SDK

```ts
import { ship, pyreEnv, NotAuthenticatedError } from "@pyre/app-sdk";
import { PyreProvider, usePyre, LoginButton, HolderGate } from "@pyre/app-sdk/react";
```

```ts
pyreEnv()                          // { appId, slug, name, ticker, chainId, tokenAddress, basePath, holderMin, functions, … }
await ship.fn<T>("hello", input)   // POST /_pyre/fn/hello → your handler's return value
await ship.kv.set("k", value)      // per-user storage (any JSON)
await ship.kv.get<T>("k")          // T | null
await ship.kv.app<T>("k")          // app-wide namespace, written by functions/*.js
await ship.coins.list({ sort: "trending", limit: 50 })   // every live coin on Pyre: { items: PyreCoin[] } — real prices, mcap, 24h change, volume, holders
await ship.coins.get("slug")                            // one coin (PyreCoin)
await ship.coins.candles("slug", { interval: "1h", limit: 168 }) // OHLCV history in USD
// Same-origin GET /_pyre/coins, /_pyre/coins/:slug, /_pyre/coins/:slug/candles — no keys, no CORS. Locally (no host) these are unavailable: show a labelled example dataset.
await ship.me()                    // { user, holder }
```

```tsx
const { user, holder, loading, login, logout, refresh } = usePyre();
```

A function declared with `auth: true` answers `401` for anonymous callers, so `ship.fn()` throws
`NotAuthenticatedError` — offer `<LoginButton/>`, never build a login flow yourself. `holderOnly: true`
answers `403` for non-holders.

`<HolderGate>` unlocks for users holding the app's coin (`pyreEnv().tokenAddress`, whole tokens).
Its default fallback links to the coin on PONS.

## Local development

```
npm run dev        http://localhost:5173
npm run build      typecheck + vite build → dist/
npm test           Playwright (starts `npm run preview` on :4173)
npm run lint       the rules above
```

`dev/pyre-local-host.ts` serves `/_pyre/*` locally: `env.js` is derived from `pyre.manifest.json`,
`/_pyre/fn/<name>` really executes `functions/<name>.js`, and app-scope `ship.kv` lives in memory.
Locally there is no Pyre session and no coin, so login, per-user `ship.kv` and holder gating answer
with an explanatory error or stay closed — that is expected. Write the UI so the signed-out path
always renders (the smoke test runs signed out).

## Product expectations

- Make the first screen useful with no login: nobody signs in to see an empty page.
- Gate depth, not basics: `<HolderGate>` unlocks extra depth for holders; everything else is free.
- Mobile first — the platform screenshots 390×844 and 1280×800 and scores Lighthouse.
- Every visible string is yours to choose; keep copy short, concrete and lowercase-calm — no
  exclamation marks, no emoji.
