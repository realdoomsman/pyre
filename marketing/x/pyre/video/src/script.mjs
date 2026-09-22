// The film, as data. Beats → shots (visuals) → sentences (voice-over).
// voice.mjs synthesises each sentence, measures it, and stretches shots so
// the words fit; the result is build/timeline.json (+ build/timeline.js for
// the browser scene). script.md, the .srt and the scenes all read from that.
//
// `say` is what edge-tts speaks; `text` is what the captions show.

export const VOICE = "en-US-AndrewMultilingualNeural";
export const RATE = "+10%";
export const FPS = 30;

/** Seconds of silence before the first sentence of a shot, and after the last. */
export const LEAD = 0.35;
export const TAIL = 0.45;
/** Gap between consecutive sentences inside one shot. */
export const GAP = 0.22;

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
      { shot: "fees-mg", text: "60 to the build budget, 25 to a $PYRE buyback, 15 to the launcher.", say: "Sixty to the build budget, twenty-five to a Pyre buyback, fifteen to the launcher." },
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
      { shot: "app-mg", text: "It goes live on its own subdomain and charges in stablecoin. No gas.", say: "It goes live on its own subdomain and charges in stablecoin. No gas." },
    ],
  },
  {
    id: "revenue",
    shots: [
      { id: "revenue-mg", base: 3.4 },
      { id: "revenue-cap", base: 2.8 },
    ],
    sentences: [
      { shot: "revenue-mg", text: "85% of revenue buys the coin back.", say: "Eighty-five percent of revenue buys the coin back." },
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
      { shot: "proof", text: "408 tests, 62 of 68 production features, an independent security review.", say: "Four hundred and eight tests, sixty-two of sixty-eight production features, an independent security review." },
    ],
  },
  {
    id: "close",
    shots: [{ id: "close", base: 4.4, lead: 0.6 }],
    sentences: [{ shot: "close", text: "Pyre. Launching soon on Robinhood Chain.", say: "Pyre. Launching soon on Robinhood Chain." }],
  },
];

/** Flat list of shots in order with their beat id. */
export const SHOTS = BEATS.flatMap((b) => b.shots.map((s) => ({ ...s, beat: b.id })));
export const SENTENCES = BEATS.flatMap((b, bi) => b.sentences.map((s, si) => ({ ...s, beat: b.id, key: `${String(bi).padStart(2, "0")}-${si}` })));

/**
 * Given measured sentence durations (seconds, by key), lay the film out.
 * Returns { fps, duration, shots:[{id,beat,start,dur}], sentences:[{key,shot,text,start,end}], events }.
 */
export function layout(durations) {
  const shots = SHOTS.map((s) => ({ id: s.id, beat: s.beat, base: s.base, lead: s.lead ?? LEAD, dur: s.base }));
  const byShot = new Map(shots.map((s) => [s.id, s]));
  // stretch shots to fit their sentences
  for (const s of shots) {
    const mine = SENTENCES.filter((x) => x.shot === s.id);
    if (!mine.length) continue;
    const spoken = mine.reduce((a, x) => a + durations[x.key], 0) + GAP * (mine.length - 1);
    s.dur = Math.max(s.base, s.lead + spoken + TAIL);
  }
  let t = 0;
  for (const s of shots) {
    s.start = +t.toFixed(3);
    s.dur = +s.dur.toFixed(3);
    t += s.dur;
  }
  const sentences = [];
  for (const s of shots) {
    let at = s.start + s.lead;
    for (const x of SENTENCES.filter((x) => x.shot === s.id)) {
      const d = durations[x.key];
      sentences.push({ key: x.key, shot: s.id, beat: x.beat, text: x.text, say: x.say, start: +at.toFixed(3), end: +(at + d).toFixed(3) });
      at += d + GAP;
    }
  }
  const duration = +t.toFixed(3);
  const burnShot = byShot.get("burn-mg");
  const events = {
    // wipe transitions sit on every shot boundary except the first frame
    wipes: shots.slice(1).map((s) => s.start),
    // the low thump lands when the stack goes hollow (scene-local 2.6 s, see scenes.js)
    burn: +(burnShot.start + 2.6).toFixed(3),
    end: duration,
  };
  return { fps: FPS, duration, shots: shots.map(({ id, beat, start, dur }) => ({ id, beat, start, dur })), sentences, events };
}
