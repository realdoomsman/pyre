// pyre-solana — PYRE moves from Robinhood Chain to Solana, as data. Same shape as
// script-venues.mjs: beats → shots (visuals) → sentences (voice-over). voice.mjs
// measures each sentence and stretches shots so the words fit; the result is
// build/solana/timeline.json (+ timeline.js for the browser scene).
//
// `say` is what edge-tts speaks; `text` is what the captions show (lowercase,
// declarative). "coin" not "token"; pump.fun lowercase; never $PYRE; no price talk,
// no launch date, no SOL amount, no ticker for the new coin. Every motion-graphic
// shot only (no captures).

import { layoutFilm, flattenShots, flattenSentences } from "./timeline.mjs";
export { FPS, LEAD, TAIL, GAP } from "./timeline.mjs";

export const VOICE = "en-US-AndrewMultilingualNeural";
export const RATE = "+10%";

/** The snapshot, exactly as announced. */
export const SNAPSHOT_BLOCK = "79819827";
export const SNAPSHOT_TIME = "2026-10-04 09:12:28 UTC";

export const BEATS = [
  {
    id: "open",
    shots: [{ id: "s-open", base: 3.0, lead: 0.6 }],
    sentences: [{ shot: "s-open", text: "PYRE is moving to solana.", say: "Pyre is moving to Solana." }],
  },
  {
    id: "move",
    shots: [{ id: "s-move", base: 5.0 }],
    sentences: [
      { shot: "s-move", text: "the main coin relaunches on pump.fun: a fair launch, no presale, one curve for everyone.", say: "The main coin relaunches on pump dot fun: a fair launch, no presale, one curve for everyone." },
    ],
  },
  {
    id: "why",
    shots: [{ id: "s-why", base: 5.0 }],
    sentences: [
      { shot: "s-why", text: "traders and builders are on solana. same loop: fees pay an AI agent to build apps.", say: "Traders and builders are on Solana. Same loop: fees pay an A.I. agent to build apps." },
    ],
  },
  {
    id: "snapshot",
    shots: [{ id: "s-snap", base: 9.0 }],
    sentences: [
      { shot: "s-snap", text: "the snapshot was taken before this announcement. PYRE bought after it does not count.", say: "The snapshot was taken before this announcement. Pyre bought after it does not count." },
      { shot: "s-snap", text: "and you have to keep holding: sell or move it after the snapshot and your refund shrinks.", say: "And you have to keep holding: sell or move it after the snapshot, and your refund shrinks." },
    ],
  },
  {
    id: "refund",
    shots: [{ id: "s-refund", base: 4.5 }],
    sentences: [
      { shot: "s-refund", text: "each holder is owed the ETH they put in: spent buying, minus received selling.", say: "Each holder is owed the E.T.H. they put in: spent buying, minus received selling." },
    ],
  },
  {
    id: "fees",
    shots: [{ id: "s-fees", base: 6.0 }],
    sentences: [
      { shot: "s-fees", text: "25% of the new coin's creator fees pays refunds in SOL, pro-rata, until everyone is paid back in full.", say: "Twenty-five percent of the new coin's creator fees pays refunds in SOL, pro rata, until everyone is paid back in full." },
    ],
  },
  {
    id: "claim",
    shots: [{ id: "s-claim", base: 5.0 }],
    sentences: [
      { shot: "s-claim", text: "on pyre.fun, prove your robinhood wallet, link your solana wallet. payouts go there.", say: "On pyre dot fun, prove your Robinhood wallet, link your Solana wallet. Payouts go there." },
    ],
  },
  {
    id: "close",
    shots: [{ id: "s-close", base: 3.6, lead: 0.6 }],
    sentences: [{ shot: "s-close", text: "fair launch on pump.fun. claim site soon.", say: "Fair launch on pump dot fun. Claim site soon." }],
  },
];

export const SHOTS = flattenShots(BEATS);
export const SENTENCES = flattenSentences(BEATS);

/** Measured sentence durations → timeline. The thump lands when the snapshot block locks (scene-local 1.6 s in s-snap, see scenes.js). */
export const layout = (durations) => layoutFilm(BEATS, durations, { shot: "s-snap", at: 1.6 });

/** What is on screen per shot, for script-solana.md. */
export const PICTURE = {
  "s-open": "obsidian; mark; “PYRE is moving” / “to *solana.*”; robinhood chain → solana · pump.fun",
  "s-move": "“the main coin *relaunches* on pump.fun.”; the mark travels from a Robinhood Chain card to a Solana · pump.fun card; chips: fair launch · no presale · one curve for everyone",
  "s-why": "“where the traders *and builders are.*”; pyre already launches solana coins through pump.fun; the loop: creator fees → pay an AI agent → it builds apps",
  "s-snap": `robinhood chain block ${SNAPSHOT_BLOCK} types in Geist Mono and locks (thump); ${SNAPSHOT_TIME}; a chain line splits at the block: held at this block ✓ counts / bought after ✕ does not count; then a second row: still holding ✓ counts / sold or moved after → refund shrinks (for good; buying more doesn't raise it)`,
  "s-refund": "“owed = *what you put in.*”; ETH spent buying PYRE − ETH received selling PYRE = ETH owed; counted up to the snapshot block",
  "s-fees": "creator fees of the new solana coin as one bar, the 25 % segment lights as refunds; three holders' owed bars fill at the same rate (pro-rata) to “paid back in full”",
  "s-claim": "three steps on pyre.fun: robinhood wallet ✓ (sign a message, or sign in) → solana wallet ✓ (link and sign) → SOL payouts to that wallet; “claim site coming soon”",
  "s-close": "lockup; fair launch on pump.fun · claim site soon · pyre.fun; @PyreFun",
};

/** Capture segments this film reads from build/cap/ (none: motion graphics only). */
export const CAPTURES = [];
