// The film, as data. Beats → shots (visuals) → sentences (voice-over).
// voice.mjs synthesises each sentence, measures it, and stretches shots so
// the words fit; the result is build/timeline.json (+ build/timeline.js for
// the browser scene). script.md, the .srt and the scenes all read from that.
//
// `say` is what edge-tts speaks; `text` is what the captions show.

import { layoutFilm, flattenShots, flattenSentences } from "./timeline.mjs";
export { FPS, LEAD, TAIL, GAP } from "./timeline.mjs";

export const VOICE = "en-US-AndrewMultilingualNeural";
export const RATE = "+10%";

export const BEATS = [
  {
    id: "open",
    shots: [{ id: "open", base: 4.6, lead: 1.1 }],
    sentences: [{ shot: "open", text: "Pyre. Coins that build apps.", say: "Pyre. Coins that build apps." }],
  },
  {
    id: "launch",
    shots: [
      { id: "launch-mg", base: 6.0 },
      { id: "launch-cap", base: 2.6 },
    ],
    sentences: [
      { shot: "launch-mg", text: "Write one sentence. An agent writes the spec.", say: "Write one sentence. An agent writes the spec." },
      { shot: "launch-mg", text: "Stake 0.05 ETH, refundable, and it launches on pons.", say: "Stake point zero five ETH, refundable, and it launches on pons." },
    ],
  },
  {
    id: "fees",
    shots: [
      { id: "fees-mg", base: 6.0 },
      { id: "fees-cap", base: 2.8 },
    ],
    sentences: [
      { shot: "fees-mg", text: "70% of every trade fee comes back:", say: "Seventy percent of every trade fee comes back:" },
      { shot: "fees-mg", text: "60 to the build budget, 25 to a PYRE buyback, 15 to the launcher.", say: "Sixty to the build budget, twenty-five to a Pyre buyback, fifteen to the launcher." },
    ],
  },
  {
    id: "agent",
    shots: [{ id: "agent-mg", base: 7.5 }],
    sentences: [
      { shot: "agent-mg", text: "At $50, an agent builds in a sandbox.", say: "At fifty dollars, an agent builds in a sandbox." },
      { shot: "agent-mg", text: "Nothing deploys until the build, Lighthouse and a reviewer pass.", say: "Nothing deploys until the build, Lighthouse, and a reviewer pass." },
    ],
  },
  {
    id: "app",
    shots: [{ id: "app-mg", base: 5.0 }],
    sentences: [
      { shot: "app-mg", text: "It goes live on its own subdomain, free to use. Holders unlock features.", say: "It goes live on its own subdomain, free to use. Holders unlock features." },
    ],
  },
  {
    id: "share",
    shots: [
      { id: "share-mg", base: 3.4 },
      { id: "share-cap", base: 2.8 },
    ],
    sentences: [
      { shot: "share-mg", text: "A quarter of every fee buys PYRE.", say: "A quarter of every fee buys Pyre." },
    ],
  },
  {
    id: "burn",
    shots: [
      { id: "burn-mg", base: 7.0 },
      { id: "burn-cap", base: 3.0 },
    ],
    sentences: [
      { shot: "burn-mg", text: "Then it burns. Supply falls.", say: "Then it burns. Supply falls." },
      { shot: "burn-mg", text: "Every burn carries an attestation anyone can reproduce.", say: "Every burn carries an attestation anyone can reproduce." },
    ],
  },
  {
    id: "dormant",
    shots: [{ id: "dormant-mg", base: 4.2 }],
    sentences: [
      { shot: "dormant-mg", text: "No budget, no agent. Any new fee relights it.", say: "No budget, no agent. Any new fee relights it." },
    ],
  },
  {
    id: "proof",
    shots: [{ id: "proof", base: 6.0 }],
    sentences: [
      { shot: "proof", text: "Every test, every audit and an independent security review, in the public repo.", say: "Every test, every audit, and an independent security review, in the public repo." },
    ],
  },
  {
    id: "close",
    shots: [{ id: "close", base: 4.4, lead: 0.6 }],
    sentences: [{ shot: "close", text: "Pyre. Live on Robinhood Chain.", say: "Pyre. Live on Robinhood Chain." }],
  },
];

export const SHOTS = flattenShots(BEATS);
export const SENTENCES = flattenSentences(BEATS);

/** Measured sentence durations (seconds, by key) → timeline. The thump lands when the stack goes hollow (scene-local 2.6 s, see scenes.js). */
export const layout = (durations) => layoutFilm(BEATS, durations, { shot: "burn-mg", at: 2.6 });

/** Capture segments (capture.mjs) this film's scenes read from build/cap/. */
export const CAPTURES = ["launch", "home", "loop", "kiln", "fees", "burns"];

/** What is on screen per shot, for script.md. */
export const PICTURE = {
  open: "obsidian; “coins that *build* apps.” rises through a mask; heat lifts from the bottom edge; “every fee *burns* PYRE.”",
  "launch-mg": "prompt box types the one sentence → spec card (what / who it is for / mvp / holder tier) → stake pill → launch line with the PONS v2 factory address",
  "launch-cap": "real capture: pyre.fun/launch hero, pointer onto the live preview card (parallax)",
  "fees-mg": "1% fee bar → 70% creator share → splits fill 60 / 25 / 15",
  "fees-cap": "real capture: coin page, “the loop” panel, pointer walks the four cells · demo data",
  "agent-mg": "console streams the build log; gate checklist lights: build · playwright · screenshots · lighthouse · reviewer → deploy",
  "app-mg": "browser frame <slug>.pyre.fun; free app, holder-tier card unlocks from balanceOf; “no checkout · no gas · no charge”",
  "share-mg": "share bar fills 25 / 75; 25% buys PYRE and burns, 0 app coins bought back",
  "share-cap": "real capture: pyre.fun home feed, pointer sweeps the ranked cards · demo data",
  "burn-mg": "supply stack hollows from the top; buy → burn() → totalSupply falls; attestation calldata types out",
  "burn-cap": "real capture: pyre.fun/burns ledger, chart tilting into the table · demo data",
  "dormant-mg": "the mark cools to ash at $0 budget; a fee arrives and the heat rises again",
  proof: "unit tests · production audit · 1 high + 5 medium review findings fixed (counts filled from the post-cutover run)",
  close: "lockup; pyre.fun · Robinhood Chain · @PyreFun; $PYRE live · buybacks are burns, never distributions",
};
