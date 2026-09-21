# @pyre/app-sdk

Browser SDK for apps hosted on **Pyre**. It is the *only* sanctioned way for an app to touch
identity, money or storage. Everything it calls lives on the app's own origin under `/_pyre/*`,
so it works with the platform's strict CSP; in-app login loads Google Identity Services from
`https://accounts.google.com`.

```
npm i @pyre/app-sdk          # already a dependency of the Pyre template
```

Two entry points:

| import | contents |
| --- | --- |
| `@pyre/app-sdk` | framework-free `ship` object, types, errors |
| `@pyre/app-sdk/react` | `<PyreProvider>`, `usePyre()`, `<LoginButton/>`, `<HolderGate/>`, `<AdSlot/>`, `<Checkout/>` |

## Hard rules for app code

1. **Never write auth, wallet or payment code.** No `viem`/`ethers`/`wagmi`, no `window.ethereum`, no
   signature handling in your app — the platform holds each user's custodial Robinhood Chain wallet
   and signs on their behalf. Use `<LoginButton/>`, `usePyre().charge()` and `<Checkout/>`.
2. **Never call `fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource`.** Server work belongs in
   `functions/<name>.js`, reached with `ship.fn(name, input)`.
3. **Never add `<script src>` or `eval`.** The CSP is `script-src 'self'` and the reviewer rejects it.
4. Keep `pyre.manifest.json` in sync: every function you call and product you sell must be declared.

## Runtime environment

The host injects `<script src="/_pyre/env.js">` before `</head>`, which assigns `window.__PYRE__`:

```ts
{
  appId, slug, name, ticker, googleClientId, apiOrigin,
  chainId: 4663,            // Robinhood Chain
  usdg,                     // USDG (Global Dollar) ERC-20 — the currency of every payment
  treasury,                 // platform treasury address (recipient of payments)
  tokenAddress,             // the app's coin (PONS v2 launch token); "" until launched
  explorerUrl,              // https://robinhoodchain.blockscout.com
  basePath,                 // "" on <slug>.<domain>, "/a/<slug>" when path-routed
  holderMin, adSlot,
  products:  [{ id, name, priceUsd, kind }],
  functions: [{ name, priceUsd, auth, holderOnly }],
}
```

`pyreEnv()` returns it (throwing a clear error outside a hosted app; `hasPyreEnv()` tells you
whether it is there) and every request is resolved against `basePath`, so the same bundle works on
a subdomain and under a path prefix. The chain fields are informational — the browser never signs.

## `ship` — framework free

```ts
import { ship } from "@pyre/app-sdk";

ship.env                                  // PyreEnv
await ship.me()                           // { user, holder:{isHolder,balance,minHold}, purchases }
await ship.holder()                       // just the holder block

await ship.kv.set("draft", { text: "…" }) // per-user storage, any JSON
await ship.kv.get<Draft>("draft")         // Draft | null
await ship.kv.del("draft")
await ship.kv.app<number>("hits")         // app-wide namespace, written by functions/*.js

await ship.fn<Reply>("hello", { name })   // POST /_pyre/fn/hello, returns the handler's value
await ship.track()                        // session ping; fired once automatically on load
await ship.ad()                           // AdCreative | null  (<AdSlot/> uses this)
ship.adUrl()                              // "/a/slug/_pyre/ad"
await ship.logout()                       // drops the app session cookie
```

Prices are USD. Money on the wire is **USDG units as `bigint`** (`1_000_000n` = $1; USDG has 6
decimals, `USDG_DECIMALS`). `formatUsdg(units)` renders it.

### Priced functions (x402)

A function with `priceUsd > 0` is charged in USDG to the caller's custodial Pyre wallet on the
server: the wallet signs an EIP-3009 `TransferWithAuthorization` and the treasury relays it, so
the user needs no ETH for gas. No client signing, no retry. When the wallet cannot cover the price
the call answers `402` and `ship.fn()` throws `InsufficientFundsError`:

```ts
import { InsufficientFundsError } from "@pyre/app-sdk";

try {
  await ship.fn("summarize", { url });
} catch (e) {
  if (e instanceof InsufficientFundsError) {
    e.priceUsd;        // number | null
    e.balanceUsd;      // number | null — what the wallet holds right now
    e.depositAddress;  // string | null — the user's own address: send USDG on Robinhood Chain here
  }
}
```

### Errors

`PyreError` (base, with `status` and `code`), `NotAuthenticatedError` (401),
`InsufficientFundsError` (402, carries `priceUsd`, `balanceUsd` and `depositAddress`).

## React

```tsx
// src/main.tsx
import { PyreProvider } from "@pyre/app-sdk/react";

createRoot(document.getElementById("root")!).render(
  <PyreProvider>
    <App />
  </PyreProvider>,
);
```

`<PyreProvider>` loads `/_pyre/me`, exposes the session, and drives in-app Google sign-in: `login()`
opens Google Identity Services, then exchanges the returned ID token for the app's session cookie.

```tsx
const { user, holder, purchases, loading, login, logout, charge, refresh } = usePyre();
```

| field | type |
| --- | --- |
| `user` | `{ id, wallet, displayName } \| null` — `wallet` is the user's custodial 0x address |
| `holder` | `{ isHolder, balance, minHold }` — whole tokens as decimal strings |
| `purchases` | `string[]` of product ids already paid for |
| `loading` | `true` until `/_pyre/me` answered |
| `login()` | runs Google sign-in and establishes the session |
| `logout()` | clears the app session cookie |
| `charge(productId)` | custodial USDG checkout → `{ status: "PAID", expiresAt, txHash }` |
| `refresh()` | re-reads `/_pyre/me` |

`charge()` calls `POST /_pyre/checkout`; the platform moves the price in USDG from the user's
custodial wallet to the treasury (treasury-relayed, so the wallet needs no ETH) and records the paid
purchase. It throws `InsufficientFundsError` when the wallet is short of USDG — show
`depositAddress` and ask the user to top up.

### Components

```tsx
<LoginButton className="btn">Sign in</LoginButton>

<HolderGate fallback={<p>Hold $TICKER to unlock</p>}>
  <SecretStuff />
</HolderGate>

<HolderGate min={50_000}>…</HolderGate>      {/* explicit threshold in whole tokens */}

<Checkout productId="pro-unlock" onPaid={(r) => console.log(r.expiresAt)} />

<AdSlot className="mt-8" />                   {/* renders nothing when adSlot is off */}
```

All components accept `className` (styled by your Tailwind classes); without one they fall back to
minimal inline styles so a fresh app still looks intentional.

## Server functions

`functions/<name>.js` runs in the platform's QuickJS sandbox — no network, no imports, 5s CPU, 64MB:

```js
export default async function handler(input, ship) {
  const hits = (await ship.kv.get("hits")) ?? 0;
  await ship.kv.set("hits", hits + 1);
  return { greeting: `hello ${input.name ?? "world"}`, hits: hits + 1 };
}
```

Inside a function, `ship` exposes:

| member | meaning |
| --- | --- |
| `ship.input` | the request body (`{}` when empty), same value as the `input` argument |
| `ship.user` | always an object `{ id: string \| null, wallet: string \| null, isHolder: boolean }` — `id` is `null` when anonymous |
| `ship.kv.get/set/del(key)` | app-scope storage; key `^[A-Za-z0-9_.:-]{1,120}$`, value JSON ≤ 64KB |
| `ship.llm(prompt, { maxTokens })` | one haiku call, `maxTokens ≤ 1024`, prompt ≤ 12000 chars, billed to the app budget |
| `ship.fetch(url, body?)` | POST JSON to another Pyre app's `/_pyre/fn/<name>`; returns its unwrapped result |

The returned value must be JSON under 1MB; it is exactly what `ship.fn()` resolves to.
