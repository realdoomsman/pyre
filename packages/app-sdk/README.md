# @pyre/app-sdk

Browser SDK for apps hosted on **Pyre**. It is the *only* sanctioned way for an app to touch
identity or storage. Everything it calls lives on the app's own origin under `/_pyre/*`, so it
works with the platform's strict CSP; in-app login loads Google Identity Services from
`https://accounts.google.com`.

Apps on Pyre are free to use: there is no checkout, no subscription and no per-call price. The
only thing an app can gate on is holding its coin (`<HolderGate/>`).

```
npm i @pyre/app-sdk          # already a dependency of the Pyre template
```

Two entry points:

| import | contents |
| --- | --- |
| `@pyre/app-sdk` | framework-free `ship` object, types, errors |
| `@pyre/app-sdk/react` | `<PyreProvider>`, `usePyre()`, `<LoginButton/>`, `<HolderGate/>` |

## Hard rules for app code

1. **Never write auth or wallet code.** No `viem`/`ethers`/`wagmi`, no `window.ethereum`, no
   signature handling in your app — the platform holds each user's Robinhood Chain wallet and
   reads holder balances for you. Use `<LoginButton/>` and `<HolderGate/>`.
2. **Never add payments.** No prices, paywalls, tips, subscriptions or ads of any kind.
3. **Never call `fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource`.** Server work belongs in
   `functions/<name>.js`, reached with `ship.fn(name, input)`.
4. **Never add `<script src>` or `eval`.** The CSP is `script-src 'self'` and the reviewer rejects it.
5. Keep `pyre.manifest.json` in sync: every function you call must be declared.

## Runtime environment

The host injects `<script src="/_pyre/env.js">` before `</head>`, which assigns `window.__PYRE__`:

```ts
{
  appId, slug, name, ticker, version, googleClientId, apiOrigin,
  chainId: 4663,            // Robinhood Chain
  tokenAddress,             // the app's coin (PONS v2 launch token); "" until launched
  explorerUrl,              // https://robinhoodchain.blockscout.com
  basePath,                 // "" on <slug>.<domain>, "/a/<slug>" when path-routed
  holderMin,                // whole tokens required by the holder tier
  functions: [{ name, auth, holderOnly }],
}
```

`pyreEnv()` returns it (throwing a clear error outside a hosted app; `hasPyreEnv()` tells you
whether it is there) and every request is resolved against `basePath`, so the same bundle works on
a subdomain and under a path prefix. The chain fields are informational — the browser never signs.

## `ship` — framework free

```ts
import { ship } from "@pyre/app-sdk";

ship.env                                  // PyreEnv
await ship.me()                           // { user, holder:{isHolder,balance,minHold} }
await ship.holder()                       // just the holder block

await ship.kv.set("draft", { text: "…" }) // per-user storage, any JSON
await ship.kv.get<Draft>("draft")         // Draft | null
await ship.kv.del("draft")
await ship.kv.app<number>("hits")         // app-wide namespace, written by functions/*.js

await ship.fn<Reply>("hello", { name })   // POST /_pyre/fn/hello, returns the handler's value
await ship.track()                        // session ping; fired once automatically on load
await ship.login()                        // Google sign-in → app session cookie
await ship.logout()                       // drops the app session cookie
```

### Errors

`PyreError` (base, with `status` and `code`) and `NotAuthenticatedError` (401). A function
declared with `auth: true` throws `NotAuthenticatedError` for anonymous callers; `holderOnly: true`
answers `403` (`PyreError` with `code: "http_403"`).

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
const { user, holder, loading, login, logout, refresh } = usePyre();
```

| field | type |
| --- | --- |
| `user` | `{ id, wallet, displayName } \| null` — `wallet` is the user's 0x address |
| `holder` | `{ isHolder, balance, minHold }` — whole tokens as decimal strings |
| `loading` | `true` until `/_pyre/me` answered |
| `login()` | runs Google sign-in and establishes the session |
| `logout()` | clears the app session cookie |
| `refresh()` | re-reads `/_pyre/me` |

### Components

```tsx
<LoginButton className="btn">Sign in</LoginButton>

<HolderGate fallback={<p>Hold $TICKER to unlock</p>}>
  <SecretStuff />
</HolderGate>

<HolderGate min={50_000}>…</HolderGate>      {/* explicit threshold in whole tokens */}
```

All components accept `className`; without one they fall back to the Pyre look (violet button,
ink text, 8px radius) so a fresh app still looks intentional.

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
| `ship.llm(prompt, { maxTokens })` | one haiku call, `maxTokens ≤ 1024`, prompt ≤ 12000 chars, billed to the app's build budget |
| `ship.fetch(url, body?)` | POST JSON to another Pyre app's `/_pyre/fn/<name>`; returns its unwrapped result |

The returned value must be JSON under 1MB; it is exactly what `ship.fn()` resolves to.
