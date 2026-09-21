// Tiny WAV + ffmpeg helpers shared by voice/music/sfx.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

export const SR = 48000;

/** Write float channels (clamped) as 16-bit PCM WAV. */
export function writeWav(path, channels, sr = SR) {
  const n = channels[0].length;
  const ch = channels.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(buf.length - 8, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  writeFileSync(path, buf);
}

/** Decode any audio file to mono float samples at `sr` via ffmpeg (optionally trimming silence). */
export function decode(path, { sr = SR, trim = false } = {}) {
  const af = trim
    ? ["-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.04,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse"]
    : [];
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, ...af, "-ac", "1", "-ar", String(sr), "-f", "f32le", "pipe:1"], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
