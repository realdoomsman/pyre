// pyre-venues — the multi-venue update, as data. Same shape as script.mjs:
// beats → shots (visuals) → sentences (voice-over). voice.mjs measures each
// sentence and stretches shots so the words fit; the result is
// build/venues/timeline.json (+ timeline.js for the browser scene).
//
// `say` is what edge-tts speaks; `text` is what the captions show (lowercase,
// declarative). "coin" not "token"; pons and pump.fun lowercase; never $PYRE.

import { layoutFilm, flattenShots, flattenSentences } from "./timeline.mjs";
export { FPS, LEAD, TAIL, GAP } from "./timeline.mjs";

export const VOICE = "en-US-AndrewMultilingualNeural";
export const RATE = "+10%";

export const BEATS = [
  {
    id: "open",
    shots: [{ id: "v-open", base: 3.2, lead: 0.6 }],
    sentences: [{ shot: "v-open", text: "pyre. coins that build apps. now from two venues.", say: "Pyre. Coins that build apps. Now from two venues." }],
  },
  {
    id: "start",
    shots: [{ id: "v-home-cap", base: 5.0 }],
    sentences: [
      { shot: "v-home-cap", text: "one launchpad was the start: every coin so far launched on pons.", say: "One launchpad was the start: every coin so far launched on pons." },
    ],
  },
  {
    id: "venue",
    shots: [{ id: "v-picker-cap", base: 7.0 }],
    sentences: [
      { shot: "v-picker-cap", text: "now you can launch from solana through pump.fun.", say: "Now you can launch from Solana through pump dot fun." },
      { shot: "v-picker-cap", text: "stake 1 SOL, refundable. same agent, same spec.", say: "Stake one SOL, refundable. Same agent, same spec." },
    ],
  },
  {
    id: "coin",
    shots: [{ id: "v-coin-cap", base: 7.0 }],
    sentences: [
      { shot: "v-coin-cap", text: "same coin page: a solana chip, a link to pump.fun, a trade panel in SOL.", say: "Same coin page: a Solana chip, a link to pump dot fun, a trade panel in SOL." },
    ],
  },
  {
    id: "loop",
    shots: [{ id: "v-fees-mg", base: 8.0 }],
    sentences: [
      { shot: "v-fees-mg", text: "same loop: the agent builds the app, fees fund it, fees burn the coin.", say: "Same loop: the agent builds the app, fees fund it, fees burn the coin." },
      { shot: "v-fees-mg", text: "60 build, 25 burn, 15 launcher. on solana the burn buys the coin itself.", say: "Sixty build, twenty-five burn, fifteen launcher. On Solana the burn buys the coin itself." },
    ],
  },
  {
    id: "burn",
    shots: [{ id: "v-burns-cap", base: 7.5 }],
    sentences: [
      { shot: "v-burns-cap", text: "every burn is 3 transactions: swap, burn, and a memo attestation anyone can open.", say: "Every burn is three transactions: swap, burn, and a memo attestation anyone can open." },
    ],
  },
  {
    id: "wallets",
    shots: [{ id: "v-me-cap", base: 5.0 }],
    sentences: [
      { shot: "v-me-cap", text: "one account, 2 custodial wallets. deposit SOL, trade from here.", say: "One account, two custodial wallets. Deposit SOL, trade from here." },
    ],
  },
  {
    id: "pyre",
    shots: [{ id: "v-pyre-mg", base: 6.0 }],
    sentences: [
      { shot: "v-pyre-mg", text: "PYRE is not moving: one coin, robinhood chain, nowhere else.", say: "Pyre is not moving: one coin, Robinhood Chain, nowhere else." },
      { shot: "v-pyre-mg", text: "any PYRE on another chain is not us.", say: "Any Pyre on another chain is not us." },
    ],
  },
  {
    id: "close",
    shots: [{ id: "v-close", base: 3.6, lead: 0.6 }],
    sentences: [{ shot: "v-close", text: "pyre. live on robinhood chain and solana.", say: "Pyre. Live on Robinhood Chain and Solana." }],
  },
];

export const SHOTS = flattenShots(BEATS);
export const SENTENCES = flattenSentences(BEATS);

/** Measured sentence durations → timeline. The thump lands when the burn leg lights (scene-local 4.6 s in v-fees-mg, see scenes.js). */
export const layout = (durations) => layoutFilm(BEATS, durations, { shot: "v-fees-mg", at: 4.6 });

/** What is on screen per shot, for script-venues.md. */
export const PICTURE = {
  "v-open": "obsidian; mark; “coins that *build* apps.” / “now from *two* venues.”; pyre.fun · robinhood chain · solana",
  "v-home-cap": "real capture: pyre.fun home, trending grid, every card chipped “Robinhood Chain · pons v2”; pointer sweeps the cards",
  "v-picker-cap": "real capture: staging /launch signed in, venue picker; pointer moves from the Robinhood card and clicks Solana · pump.fun",
  "v-coin-cap": "real capture: staging /c/devnet-lens; pointer on the Solana · pump.fun chip → View on pump.fun → the SOL trade panel",
  "v-fees-mg": "two columns, Robinhood Chain and Solana; the same 60 / 25 / 15 bars fill on both; the 25 is labelled PYRE burn vs coin burn",
  "v-burns-cap": "real capture: staging coin page, Burns tab, the one real burn; pointer rides swap → burn → attest; memo card types pyre:burn:v1:…",
  "v-me-cap": "real capture: staging /me, two custodial addresses (Robinhood, Solana); pointer clicks Deposit SOL, the tray opens",
  "v-pyre-mg": "serif card: “one coin. one chain.”; PYRE · Robinhood Chain 4663 · pons v2 → Uniswap v4; “not on solana. not bridged. not wrapped.”; inset of the real one-coin-one-chain note from pyre.fun/pyre",
  "v-close": "lockup; pyre.fun · live on Robinhood Chain and Solana · @PyreFun",
};

/** Capture segments (capture.mjs) this film's scenes read from build/cap/. */
export const CAPTURES = ["v-home", "v-picker", "v-coin", "v-burns", "v-me", "v-pyrecard"];