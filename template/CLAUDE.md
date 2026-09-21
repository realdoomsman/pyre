# Working on this app

This is a **Pyre app**: a Vite + React 19 + Tailwind v4 front end plus server functions, hosted by
the Pyre platform. The platform owns identity, money and storage. You own the product.

## Hard rules — a diff that breaks any of these is rejected by the reviewer

1. **Never write auth, wallet, signature or payment code.** No `viem`, `ethers`, `wagmi`, no
   `window.ethereum`, no key handling, no transaction building, no "connect wallet" UI of your own.
   The platform holds each user's custodial Robinhood Chain wallet and signs on their behalf. Use
   `@pyre/app-sdk`: `<LoginButton/>`, `usePyre()`, `<Checkout/>`, `<HolderGate/>`.
2. **Never call the network.** `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and any
   third-party API are forbidden — the app is served under `default-src 'self'` and calls will fail.
   All server work goes through `ship.fn(name, input)`.
3. **Never add `<script src>`, `eval`, `new Function` or `dangerouslySetInnerHTML`.** `script-src` is
   `'self'`; injected scripts break the page.
4. **Never add a dependency that talks to the internet at runtime**, and prefer adding no
   dependency at all. `eslint.config.js` enforces rules 2–3; do not weaken or disable it.
5. **`pyre.manifest.json` must stay accurate.** Every function you call must be listed in
   `functions`, every product you sell in `products`, and the `name` must equal the page's `<h1>`
   (`tests/smoke.spec.ts` checks this).
6. **Server logic lives in `functions/*.js`** and may only use the injected `ship` object. No
   imports, no `require`, no Node APIs, no network — QuickJS, 64MB, 5s CPU, result JSON ≤ 1MB.
   `ship.input` (body, `{}` when empty), `ship.user` (always an object
   `{id: string|null, wallet: string|null, isHolder: boolean}` — `id` is `null` when anonymous),
   `ship.kv.get/set/del(key)` (app scope, key `^[A-Za-z0-9_.:-]{1,120}$`, value ≤ 64KB),
   `ship.llm(prompt, {maxTokens})` (≤ 1024 tokens, billed to the build budget),
   `ship.fetch(url, body?)` (another Pyre app's `/_pyre/fn/<name>` only).
7. **Run `npm run build` and `npm test` before you finish.** Both must pass. Fix what they report;
   never leave the tree broken and never delete a test to make it pass.

## Layout

```
index.html              page shell (the platform injects /_pyre/env.js into <head>)
src/main.tsx            mounts <PyreProvider> — do not remove it
src/App.tsx             your app
src/index.css           `@import "tailwindcss";` + theme tokens
functions/<name>.js     server functions, `export default async (input, ship) => …`
pyre.manifest.json      declared functions, products, ad slot, holder tier
tests/smoke.spec.ts     Playwright smoke test (keep it passing, extend it)
dev/pyre-local-host.ts  local stand-in for /_pyre/* so dev/preview/tests run offline
```

`dist/` + `functions/` + `pyre.manifest.json` are what the platform deploys.

## The SDK

```ts
import { ship, pyreEnv, formatUsdg, InsufficientFundsError } from "@pyre/app-sdk";
import { PyreProvider, usePyre, LoginButton, HolderGate, AdSlot, Checkout } from "@pyre/app-sdk/react";
```

```ts
pyreEnv()                          // { appId, slug, name, ticker, chainId, usdg, tokenAddress, basePath, products, functions, … }
await ship.fn<T>("hello", input)   // POST /_pyre/fn/hello → your handler's return value
await ship.kv.set("k", value)      // per-user storage (any JSON)
await ship.kv.get<T>("k")          // T | null
await ship.kv.app<T>("k")          // app-wide namespace, written by functions/*.js
await ship.me()                    // { user, holder, purchases }
```

```tsx
const { user, holder, purchases, loading, login, logout, charge, refresh } = usePyre();
```

`charge(productId)` runs the whole checkout — the platform moves the price in USDG (Global Dollar,
Robinhood Chain) from the user's custodial wallet to the treasury and resolves to
`{ status: "PAID", expiresAt, txHash }`. `<Checkout productId="…" onPaid={…}/>` is the button
version. Prices are USD; money on the wire is USDG units as `bigint` (`1_000_000n` = $1;
`formatUsdg` renders it).

A function with `priceUsd > 0` is paid per call (x402): the platform charges the caller's custodial
wallet in USDG before running it, so `ship.fn()` just works. When the wallet is short it throws
`InsufficientFundsError` (`priceUsd`, `balanceUsd`, `depositAddress`) — show the deposit address
and ask the user to top up; never build a payment flow yourself.

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
Locally there is no Pyre session, no custodial wallet and no treasury, so login, per-user `ship.kv`,
payments and holder gating answer with an explanatory error or stay closed — that is expected.
Write the UI so the signed-out path always renders (the smoke test runs signed out).

## Product expectations

- Make the first screen useful with no login: nobody signs in to see an empty page.
- Gate value, not basics: `<HolderGate>` and paid products should unlock extra depth.
- Mobile first — the platform screenshots 390×844 and 1280×800 and scores Lighthouse.
- Every visible string is yours to choose; keep copy short and concrete.
