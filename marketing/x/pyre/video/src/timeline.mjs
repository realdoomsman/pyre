// Beats → timeline. Shared by every film's script module: shots stretch to fit their
// measured sentences, sentences are placed inside their shot, events mark the wipes
// and the one "thump" moment for sfx/music.
export const FPS = 30;

/** Seconds of silence before the first sentence of a shot, and after the last. */
export const LEAD = 0.35;
export const TAIL = 0.45;
/** Gap between consecutive sentences inside one shot. */
export const GAP = 0.22;

/** Flat list of shots in order with their beat id. */
export const flattenShots = (beats) => beats.flatMap((b) => b.shots.map((s) => ({ ...s, beat: b.id })));
export const flattenSentences = (beats) =>
  beats.flatMap((b, bi) => b.sentences.map((s, si) => ({ ...s, beat: b.id, key: `${String(bi).padStart(2, "0")}-${si}` })));

/**
 * Given measured sentence durations (seconds, by key), lay the film out.
 * `thump` = { shot, at } — the scene-local second the low thump lands.
 * Returns { fps, duration, shots:[{id,beat,start,dur}], sentences:[{key,shot,text,start,end}], events }.
 */
export function layoutFilm(beats, durations, thump) {
  const SHOTS = flattenShots(beats), SENTENCES = flattenSentences(beats);
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
  const events = {
    // wipe transitions sit on every shot boundary except the first frame
    wipes: shots.slice(1).map((s) => s.start),
    burn: +(byShot.get(thump.shot).start + thump.at).toFixed(3),
    end: duration,
  };
  return { fps: FPS, duration, shots: shots.map(({ id, beat, start, dur }) => ({ id, beat, start, dur })), sentences, events };
}
