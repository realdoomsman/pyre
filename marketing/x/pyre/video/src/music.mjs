// Ambient pad for pyre-launch. Pure DSP, deterministic, no samples.
// Detuned saws → 2-pole low-pass with a slow sweep, sub sine on the root,
// a soft 64 BPM pulse, Schroeder-ish reverb. A minor. Length = timeline.
//   node src/music.mjs → build/music.wav (stereo 48k)
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SR, writeWav, readJson } from "./wav.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");

const BPM = 64;
const beat = 60 / BPM;
const bar = beat * 4;

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// chords as midi note lists (A minor): Am9 · Fmaj7 · Cmaj7 · G6 · Am9 · Fmaj7 · Dm9 · E(sus)…
const CHORDS = [
  [57, 64, 67, 71],      // A C E G  (Am7, open)
  [53, 60, 64, 69],      // F A C E  (Fmaj7)
  [48, 55, 64, 67],      // C G E G  (C, wide)
  [55, 62, 66, 71],      // G D F# B (Gmaj7-ish, lift)
  [57, 64, 67, 71],
  [53, 60, 64, 69],
  [50, 57, 60, 65],      // D F A C  (Dm7)
  [52, 59, 64, 68],      // E B E G# (E, tension) → resolves to Am
];
const CHORD_BARS = 2;

/** 2-pole state-variable low-pass, per channel */
class SVF {
  constructor() { this.lp = 0; this.bp = 0; }
  run(x, f, q) {
    const g = Math.tan(Math.PI * Math.min(f, SR * 0.45) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const hp = a1 * (x - (g + k) * this.bp - this.lp);
    const bpn = g * hp + this.bp;
    const lpn = g * bpn + this.lp;
    this.bp = g * hp + bpn;
    this.lp = g * bpn + lpn;
    return lpn;
  }
}

/** cheap reverb: 4 combs + 2 allpasses (Schroeder) */
class Reverb {
  constructor(seedOffset = 0) {
    this.combs = [1557, 1617, 1491, 1422].map((n) => ({ buf: new Float32Array(n + seedOffset), i: 0, fb: 0.86 }));
    this.aps = [225, 556].map((n) => ({ buf: new Float32Array(n + (seedOffset >> 1)), i: 0 }));
  }
  run(x) {
    let y = 0;
    for (const c of this.combs) {
      const out = c.buf[c.i];
      c.buf[c.i] = x + out * c.fb;
      c.i = (c.i + 1) % c.buf.length;
      y += out;
    }
    y *= 0.25;
    for (const a of this.aps) {
      const d = a.buf[a.i];
      const out = -y + d;
      a.buf[a.i] = y + d * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      y = out;
    }
    return y;
  }
}

/** `tl` = a timeline ({duration, events:{burn}}); defaults to this film's build/timeline.json. */
export function buildMusic({ tl = readJson(join(BUILD, "timeline.json")), out = join(BUILD, "music.wav") } = {}) {
  const DUR = tl.duration + 0.5;
  const N = Math.ceil(DUR * SR);
  const L = new Float32Array(N), R = new Float32Array(N);
  const burnAt = tl.events.burn;

  // voices: per chord note, 3 detuned saws (−7, 0, +7 cents), slow individual vibrato
  const DET = [-7, 0, 7];
  const filtL = new SVF(), filtR = new SVF();
  const revL = new Reverb(0), revR = new Reverb(23);
  const phases = new Float64Array(8 * 3);
  let subPhase = 0;

  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const barIdx = Math.floor(t / bar);
    const chordIdx = Math.floor(barIdx / CHORD_BARS) % CHORDS.length;
    const chord = CHORDS[chordIdx];
    const tInChord = t - Math.floor(t / (bar * CHORD_BARS)) * bar * CHORD_BARS;
    // crossfade in/out of each chord so changes breathe
    const env = Math.min(1, tInChord / 1.4) * Math.min(1, (bar * CHORD_BARS - tInChord) / 1.6 + 0.35);

    let sL = 0, sR = 0;
    for (let n = 0; n < chord.length; n++) {
      const f0 = midi(chord[n]);
      for (let d = 0; d < 3; d++) {
        const k = n * 3 + d;
        const vib = 1 + 0.0009 * Math.sin(2 * Math.PI * (0.11 + 0.017 * k) * t + k);
        const f = f0 * Math.pow(2, DET[d] / 1200) * vib;
        phases[k] += f / SR;
        if (phases[k] >= 1) phases[k] -= 1;
        const saw = 2 * phases[k] - 1;
        const amp = 0.05 * (n === 0 ? 1.1 : 0.8);
        // spread detuned copies across the field
        const pan = d === 0 ? 0.3 : d === 2 ? 0.7 : 0.5;
        sL += saw * amp * (1 - pan);
        sR += saw * amp * pan;
      }
    }
    sL *= env; sR *= env;

    // filter sweep: slow breathing, opens toward the burn beat, closes at the end
    const swell = Math.exp(-Math.pow((t - burnAt) / 6, 2));
    const cutoff = 420 + 260 * Math.sin(2 * Math.PI * t / 23) + 900 * swell + 200 * Math.max(0, 1 - t / 8) * -1;
    const fL = filtL.run(sL, cutoff, 0.8), fR = filtR.run(sR, cutoff * 1.03, 0.8);

    // sub on the chord root (an octave below), very quiet
    const root = midi(chord[0] - 12);
    subPhase += root / SR; if (subPhase >= 1) subPhase -= 1;
    const sub = Math.sin(2 * Math.PI * subPhase) * 0.07 * env;

    // soft pulse: filtered sine thump on each beat, a lighter one on the off-beat
    const tb = t % beat;
    const beatNo = Math.floor(t / beat) % 4;
    const pulseAmp = beatNo === 0 ? 0.11 : beatNo === 2 ? 0.07 : 0.045;
    const pulse = Math.sin(2 * Math.PI * (52 - 12 * Math.min(1, tb / 0.08)) * tb) * Math.exp(-tb * 11) * pulseAmp;

    const dryL = fL + sub + pulse, dryR = fR + sub + pulse;
    const wetL = revL.run(dryL * 0.35), wetR = revR.run(dryR * 0.35);
    let oL = dryL + wetL * 0.6, oR = dryR + wetR * 0.6;

    // master fades
    const fadeIn = Math.min(1, t / 2.5);
    const fadeOut = Math.min(1, Math.max(0, (DUR - t) / 3.5));
    const g = fadeIn * fadeOut;
    L[i] = Math.tanh(oL * g * 1.4);
    R[i] = Math.tanh(oR * g * 1.4);
  }
  writeWav(out, [L, R]);
  console.log(`[music] ${out} ${DUR.toFixed(1)}s · ${BPM} bpm · A minor`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) buildMusic();
