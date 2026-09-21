// On-brand chiptune bed for the Berth launch video.
// Deterministic DSP: pulse/triangle voices + kick/hat. No samples, no AI.
// A-minor, ~112 BPM, progression Am - F - C - G. ~48s.
import fs from "node:fs";

const SR = 44100;
const BPM = 112;
const beat = 60 / BPM;          // seconds per beat
const bar = beat * 4;
const sixteenth = beat / 4;
const BARS = 26;                 // ~ 55.7s
const DUR = BARS * bar;
const N = Math.floor(DUR * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// note name -> midi
const NAMES = { C:0, "C#":1, D:2, "D#":3, E:4, F:5, "F#":6, G:7, "G#":8, A:9, "A#":10, B:11 };
const m = (name) => { const mt = name.match(/^([A-G]#?)(-?\d)$/); return NAMES[mt[1]] + (parseInt(mt[2]) + 1) * 12; };
const f = (name) => midi(m(name));

function pulse(ph, duty) { return (ph % 1) < duty ? 1 : -1; }
function tri(ph) { const p = ph % 1; return 4 * Math.abs(p - 0.5) - 1; }

// add a note (voice) to buffers
function voice(startS, durS, freq, { type = "pulse", duty = 0.5, amp = 0.2, pan = 0, atk = 0.005, rel = 0.04, vib = 0 } = {}) {
  const s0 = Math.floor(startS * SR), s1 = Math.min(N, Math.floor((startS + durS) * SR));
  const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
  let ph = 0;
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR;
    const rem = durS - t;
    let env = 1;
    if (t < atk) env = t / atk;
    else if (rem < rel) env = Math.max(0, rem / rel);
    const fr = freq * (1 + (vib ? 0.006 * Math.sin(2 * Math.PI * 5 * t) : 0));
    ph += fr / SR;
    let v = type === "tri" ? tri(ph) : pulse(ph, duty);
    v *= env * amp;
    L[i] += v * gl; R[i] += v * gr;
  }
}

function kick(startS, amp = 0.9) {
  const s0 = Math.floor(startS * SR), s1 = Math.min(N, s0 + Math.floor(0.14 * SR));
  let ph = 0;
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR;
    const fr = 150 * Math.exp(-t * 32) + 48;
    ph += fr / SR;
    const env = Math.exp(-t * 22);
    const v = Math.sin(2 * Math.PI * ph) * env * amp;
    L[i] += v; R[i] += v;
  }
}
function hat(startS, amp = 0.16, dur = 0.03) {
  const s0 = Math.floor(startS * SR), s1 = Math.min(N, s0 + Math.floor(dur * SR));
  let last = 0;
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR;
    const env = Math.exp(-t * 90);
    const n = Math.random() * 2 - 1;
    const hp = n - last; last = n;          // crude high-pass
    const v = hp * env * amp;
    L[i] += v; R[i] += v;
  }
}

// chord roots + arp tones per bar (Am, F, C, G)
const prog = [
  { bass: "A1", arp: ["A3", "C4", "E4", "A4"] },
  { bass: "F1", arp: ["F3", "A3", "C4", "F4"] },
  { bass: "C2", arp: ["C4", "E4", "G4", "C5"] },
  { bass: "G1", arp: ["G3", "B3", "D4", "G4"] },
];
// lead motif (bar-relative sixteenth index -> note), sparse & singable
const lead = [
  ["E5", "-", "-", "C5", "-", "D5", "-", "-", "E5", "-", "-", "-", "A4", "-", "-", "-"],
  ["F5", "-", "-", "-", "E5", "-", "C5", "-", "D5", "-", "-", "-", "-", "-", "-", "-"],
  ["E5", "-", "G5", "-", "E5", "-", "C5", "-", "D5", "-", "-", "-", "G4", "-", "-", "-"],
  ["D5", "-", "-", "B4", "-", "-", "G4", "-", "A4", "-", "B4", "-", "-", "-", "-", "-"],
];

for (let b = 0; b < BARS; b++) {
  const t0 = b * bar;
  const ch = prog[b % 4];
  const intro = b < 2;             // sparse intro
  const full = b >= 4 && b < BARS - 2;
  const leadOn = b >= 8 && b < BARS - 3;

  // bass: root on beats 1 & 3 (+ octave pulse eighths when full)
  voice(t0, beat * 0.9, f(ch.bass), { type: "tri", amp: 0.34, atk: 0.004, rel: 0.06 });
  voice(t0 + 2 * beat, beat * 0.9, f(ch.bass), { type: "tri", amp: 0.34, atk: 0.004, rel: 0.06 });
  if (full) for (let e = 0; e < 8; e++) voice(t0 + e * (beat / 2), beat / 2 * 0.8, f(ch.bass) * 2, { type: "pulse", duty: 0.5, amp: 0.06, pan: -0.15 });

  // arpeggio: sixteenth notes cycling the chord tones
  if (!intro) for (let s = 0; s < 16; s++) {
    const note = ch.arp[s % 4];
    voice(t0 + s * sixteenth, sixteenth * 0.9, f(note), { type: "pulse", duty: 0.25, amp: full ? 0.12 : 0.08, pan: 0.28, atk: 0.002, rel: 0.02 });
  }

  // lead melody
  if (leadOn) { const row = lead[b % 4]; for (let s = 0; s < 16; s++) { if (row[s] !== "-") voice(t0 + s * sixteenth, sixteenth * 2.2, f(row[s]), { type: "pulse", duty: 0.5, amp: 0.15, pan: -0.25, vib: 1, atk: 0.004, rel: 0.05 }); } }

  // drums
  if (b >= 2) {
    kick(t0, 0.9); kick(t0 + 2 * beat, 0.85);
    if (full) kick(t0 + 3.5 * beat, 0.5);
    for (let e = 0; e < 8; e++) if (e % 2 === 1) hat(t0 + e * (beat / 2), b >= 4 ? 0.16 : 0.1);
    if (full && b % 4 === 3) for (let s = 12; s < 16; s++) hat(t0 + s * sixteenth, 0.12, 0.02); // fill
  }
}

// master: gentle one-pole low-pass for warmth, then soft clip, fade in/out
function master(buf) {
  let y = 0; const a = 0.6;
  for (let i = 0; i < N; i++) { y = y + a * (buf[i] - y); let v = Math.tanh(y * 1.6) * 0.82;
    // fades
    const tIn = i / SR, tOut = (N - i) / SR;
    if (tIn < 0.6) v *= tIn / 0.6;
    if (tOut < 1.2) v *= tOut / 1.2;
    buf[i] = v;
  }
}
master(L); master(R);

// write 16-bit stereo WAV
const bytes = 44 + N * 4;
const buf = Buffer.alloc(bytes);
buf.write("RIFF", 0); buf.writeUInt32LE(bytes - 8, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
let o = 44;
for (let i = 0; i < N; i++) {
  const li = Math.max(-1, Math.min(1, L[i])), ri = Math.max(-1, Math.min(1, R[i]));
  buf.writeInt16LE((li * 32767) | 0, o); o += 2;
  buf.writeInt16LE((ri * 32767) | 0, o); o += 2;
}
fs.writeFileSync("C:/tech/ship/marketing/x/video/music.wav", buf);
console.log("wrote music.wav", DUR.toFixed(2) + "s", N, "samples");
