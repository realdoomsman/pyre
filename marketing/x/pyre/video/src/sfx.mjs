// Sound design for pyre-launch: a soft whoosh on every wipe, a low thump on the
// burn. Placed from build/timeline.json events.  node src/sfx.mjs → build/sfx.wav
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SR, writeWav, readJson } from "./wav.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");

/** deterministic noise */
const rng = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296 - 0.5;
};

/** band-passed noise swell with a rising centre frequency, stereo pan sweep */
function whoosh(L, R, at, { dur = 0.75, amp = 0.28, seed = 1 } = {}) {
  const n = Math.floor(dur * SR);
  const o = Math.round(at * SR);
  const noise = rng(seed);
  let lp = 0, lp2 = 0, bp = 0;
  for (let i = 0; i < n && o + i < L.length; i++) {
    const u = i / n;
    // envelope: fast rise, long tail (the band clears the frame)
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15)), 1.6) * (u < 0.3 ? u / 0.3 : 1);
    const fc = 260 + 2600 * Math.pow(u, 1.8);
    const a = Math.min(0.95, 2 * Math.PI * fc / SR);
    const x = noise();
    lp += a * (x - lp);
    lp2 += a * (lp - lp2);
    bp = lp - lp2; // crude band-pass
    const v = bp * env * amp * 6;
    const pan = 0.5 + 0.35 * Math.sin(Math.PI * u); // drifts across and back
    L[o + i] += v * (1 - pan) * 2;
    R[o + i] += v * pan * 2;
  }
}

/** low thump: sine glides 92→36 Hz, short click, room tail */
function thump(L, R, at, { amp = 0.9 } = {}) {
  const dur = 1.4;
  const n = Math.floor(dur * SR);
  const o = Math.round(at * SR);
  let ph = 0;
  for (let i = 0; i < n && o + i < L.length; i++) {
    const t = i / SR;
    const f = 36 + 56 * Math.exp(-t * 14);
    ph += f / SR;
    const body = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 3.2);
    const click = Math.exp(-t * 400) * 0.35;
    const v = (body + click) * amp;
    L[o + i] += v;
    R[o + i] += v;
  }
}

/** `tl` = a timeline ({duration, events:{wipes,burn}}); defaults to this film's build/timeline.json. */
export function buildSfx({ tl = readJson(join(BUILD, "timeline.json")), out = join(BUILD, "sfx.wav") } = {}) {
  const N = Math.ceil((tl.duration + 0.5) * SR);
  const L = new Float32Array(N), R = new Float32Array(N);
  const peak = (buf) => 20 * Math.log10(buf.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9));
  tl.events.wipes.forEach((t, i) => whoosh(L, R, Math.max(0, t - 0.08), { seed: 7 + i * 13, amp: 0.42 }));
  const whooshPeak = peak(L);
  thump(L, R, tl.events.burn, { amp: 0.55 });
  writeWav(out, [L, R]);
  console.log(`[sfx] ${tl.events.wipes.length} whooshes (peak ${whooshPeak.toFixed(1)} dBFS), thump at ${tl.events.burn}s (peak ${peak(L).toFixed(1)} dBFS)`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) buildSfx();
