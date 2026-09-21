// The three short films, as data. Each film is a list of shots; a shot may carry
// voice-over sentences (loop, burn) or a clean text overlay (design). audio.mjs
// measures the sentences and stretches shots so the words fit; the result is
// build/<film>/timeline.json (+ timeline.js for the stage). Captions (.srt) and
// the stage read from that.
//
// `say` is what edge-tts speaks; `text` is what the captions show.

export const VOICE = "en-US-AndrewMultilingualNeural";
export const RATE = "+10%";
export const FPS = 30;
export const LEAD = 0.4;
export const TAIL = 0.5;
export const GAP = 0.22;

/** in-frame honesty captions; every mock/illustrated frame carries one */
export const CAPTION = {
  mock: "mock data · no coin has launched yet",
  example: "example input · nothing is launched",
  illustration: "illustration · no burn tx exists yet",
  sample: "design system · /_ui · sample values",
  live: "live · pyre.fun",
};

export const FILMS = {
  loop: {
    title: "the loop in 20 seconds",
    vo: true,
    music: { swellShot: "coin-cap" },
    shots: [
      { id: "open", base: 2.6, lead: 0.9, sentences: [{ text: "pyre. the loop, in twenty seconds.", say: "Pyre. The loop, in twenty seconds." }] },
      { id: "home-cap", base: 4.6, cap: "home", focal: [0.5, 0.42], sqfocal: [0.5, 0.4], zoom: [1.18, 1.1], caption: CAPTION.live,
        sentences: [{ text: "launch a coin: a name, a ticker, one sentence on the app it should build.", say: "Launch a coin: a name, a ticker, one sentence on the app it should build." }] },
      { id: "launch-cap", base: 5.6, cap: "launch", focal: [0.38, 0.5], sqfocal: [0.37, 0.52], zoom: [1.2, 1.3], caption: CAPTION.example,
        sentences: [{ text: "the coin launches on PONS v2. its trading fees pay an agent to build the app.", say: "The coin launches on pons v2. Its trading fees pay an agent to build the app." }] },
      { id: "coin-cap", base: 5.8, cap: "coin", focal: [0.5, 0.5], sqfocal: [0.42, 0.5], zoom: [1.12, 1.22], caption: CAPTION.mock,
        sentences: [{ text: "the app earns. 85% of that revenue buys the coin back and burns it.", say: "The app earns. Eighty-five percent of that revenue buys the coin back and burns it." }] },
      { id: "close", base: 3.6, lead: 0.7, sentences: [{ text: "supply falls because the app earned.", say: "Supply falls because the app earned." }] },
    ],
  },

  burn: {
    title: "how a burn is verified",
    vo: true,
    music: { swellShot: "explorer" },
    shots: [
      { id: "open", base: 2.4, lead: 0.8, sentences: [{ text: "how a burn is verified.", say: "How a burn is verified." }] },
      { id: "bytes", base: 6.6, lead: 0.6,
        sentences: [{ text: "every burn ends with an attestation tx. its calldata: the word PYRE, a version byte, a hash.", say: "Every burn ends with an attestation transaction. Its calldata: the word pyre, a version byte, a hash." }] },
      { id: "hash", base: 6.2, lead: 0.5,
        sentences: [{ text: "the hash is sha256 of the revenue event ids behind the burn. recompute it from the coin page.", say: "The hash is sha-256 of the revenue event ids behind the burn. Recompute it from the coin page." }] },
      { id: "explorer", base: 6.0, lead: 0.7, caption: CAPTION.illustration,
        sentences: [{ text: "on blockscout, the burn call lowers totalSupply. nothing moves to a wallet.", say: "On blockscout, the burn call lowers total supply. Nothing moves to a wallet." }] },
      { id: "burns-cap", base: 3.0, cap: "burns", focal: [0.5, 0.5], zoom: [1.1, 1.16], caption: CAPTION.live, sentences: [] },
      { id: "close", base: 2.6, sentences: [] },
    ],
  },

  design: {
    title: "the design system",
    vo: false,
    music: { swellShot: "kiln-cap" },
    shots: [
      { id: "open", base: 3.2 },
      { id: "hero-cap", base: 3.4, cap: "ui-hero", focal: [0.42, 0.42], sqfocal: [0.34, 0.42], zoom: [1.12, 1.2], overlay: "heat, not flame." },
      { id: "color-cap", base: 4.4, cap: "ui-color", focal: [0.5, 0.55], sqfocal: [0.5, 0.55], zoom: [1.15, 1.22], overlay: "one accent. the heat ramp: violet, cobalt, white." },
      { id: "type-cap", base: 4.2, cap: "ui-type", focal: [0.4, 0.5], sqfocal: [0.33, 0.5], zoom: [1.14, 1.2], overlay: "instrument serif · geist · geist mono" },
      { id: "kiln-cap", base: 5.4, cap: "ui-kiln", focal: [0.42, 0.55], sqfocal: [0.36, 0.55], zoom: [1.2, 1.32], overlay: "the supply kiln. each burn hollows a layer.", caption: CAPTION.sample },
      { id: "motion-cap", base: 4.6, cap: "ui-motion", focal: [0.5, 0.52], sqfocal: [0.4, 0.52], zoom: [1.14, 1.22], overlay: "digits roll in 300 ms. heat is a value axis.", caption: CAPTION.sample },
      { id: "close", base: 3.4 },
    ],
  },
};

/** Flat sentences of a film with stable keys. */
export const sentencesOf = (film) =>
  FILMS[film].shots.flatMap((s, si) => (s.sentences ?? []).map((x, i) => ({ ...x, shot: s.id, key: `${film}-${String(si).padStart(2, "0")}-${i}` })));

/**
 * Lay a film out from measured sentence durations (seconds, by key).
 * Returns { film, fps, duration, shots:[{id,start,dur,cap,...}], sentences:[{key,shot,text,start,end}], events:{wipes,burn,end} }.
 */
export function layout(film, durations = {}) {
  const spec = FILMS[film];
  const sentences = sentencesOf(film);
  const shots = spec.shots.map((s) => {
    const { sentences: _drop, ...rest } = s;
    const mine = sentences.filter((x) => x.shot === s.id);
    const lead = s.lead ?? LEAD;
    const spoken = mine.reduce((a, x) => a + (durations[x.key] ?? 0), 0) + GAP * Math.max(0, mine.length - 1);
    return { ...rest, lead, dur: mine.length ? Math.max(s.base, lead + spoken + TAIL) : s.base };
  });
  let t = 0;
  for (const s of shots) {
    s.start = +t.toFixed(3);
    s.dur = +s.dur.toFixed(3);
    t += s.dur;
  }
  const placed = [];
  for (const s of shots) {
    let at = s.start + s.lead;
    for (const x of sentences.filter((x) => x.shot === s.id)) {
      const d = durations[x.key] ?? 0;
      placed.push({ key: x.key, shot: s.id, text: x.text, say: x.say, start: +at.toFixed(3), end: +(at + d).toFixed(3) });
      at += d + GAP;
    }
  }
  const duration = +t.toFixed(3);
  const swell = shots.find((s) => s.id === spec.music.swellShot) ?? shots[Math.floor(shots.length / 2)];
  return {
    film,
    fps: FPS,
    duration,
    shots: shots.map(({ lead: _l, base: _b, ...s }) => s),
    sentences: placed,
    events: { wipes: shots.slice(1).map((s) => s.start), burn: +(swell.start + 1.2).toFixed(3), end: duration },
  };
}
