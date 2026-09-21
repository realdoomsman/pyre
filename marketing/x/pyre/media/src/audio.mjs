// Per film: voice (edge-tts, one call per sentence) → measured → timeline;
// music + sfx from the launch film's generators; mix; mux onto the renders.
//   node src/audio.mjs <film> [--force]      → build/<film>/{timeline.json,timeline.js,vo.wav,music.wav,sfx.wav,mix.wav}
//                                            → <film>-captions.srt (VO films)
//   node src/audio.mjs <film> --mux          → <film>.mp4 + <film>-square.mp4 (needs build/<film>/video-*.mp4)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FILMS, VOICE, RATE, layout, sentencesOf } from "./films.mjs";
import { SR, writeWav, decode } from "../../video/src/wav.mjs";
import { buildMusic } from "../../video/src/music.mjs";
import { buildSfx } from "../../video/src/sfx.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const ff = (args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "inherit" });

const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(r).padStart(3, "0")}`;
};

/** Illustrative revenue event ids and their real attestation hash (sorted, comma-joined, sha256). */
const attest = () => {
  const ids = ["rev_example_003", "rev_example_001", "rev_example_002"];
  const hash = `0x${createHash("sha256").update([...ids].sort().join(",")).digest("hex")}`;
  return { ids, hash };
};

export function buildTimeline(film, { force = false } = {}) {
  const dir = join(BUILD, film);
  mkdirSync(join(dir, "vo"), { recursive: true });
  const spec = FILMS[film];
  const durations = {};
  const pcm = {};
  if (spec.vo) {
    for (const s of sentencesOf(film)) {
      const mp3 = join(dir, "vo", `${s.key}.mp3`);
      if (force || !existsSync(mp3)) execFileSync("python", ["-m", "edge_tts", "--voice", VOICE, `--rate=${RATE}`, "--text", s.say, "--write-media", mp3], { stdio: "inherit" });
      const samples = decode(mp3, { trim: true });
      pcm[s.key] = samples;
      durations[s.key] = +(samples.length / SR).toFixed(3);
    }
  }
  const tl = layout(film, durations);
  if (film === "burn") tl.attest = attest();
  writeFileSync(join(dir, "timeline.json"), JSON.stringify(tl, null, 2));

  // voice track: sentences placed at their timeline start (mono 48k); silent for text-only films
  const out = new Float32Array(Math.ceil((tl.duration + 1) * SR));
  for (const s of tl.sentences) {
    const o = Math.round(s.start * SR);
    out.set(pcm[s.key].subarray(0, Math.min(pcm[s.key].length, out.length - o)), o);
  }
  writeWav(join(dir, "vo.wav"), [out]);

  if (spec.vo) {
    const srt = tl.sentences.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join("\n");
    writeFileSync(join(ROOT, `${film}-captions.srt`), srt + "\n");
  }
  const words = tl.sentences.reduce((a, s) => a + s.text.split(/\s+/).length, 0);
  console.log(`[timeline] ${film}: ${tl.shots.length} shots, ${tl.sentences.length} sentences (${words} words), ${tl.duration.toFixed(2)}s`);
  return tl;
}

export function buildAudio(film, tl) {
  const dir = join(BUILD, film);
  buildMusic({ tl, out: join(dir, "music.wav") });
  buildSfx({ tl, out: join(dir, "sfx.wav") });
  ff(["-i", join(dir, "music.wav"), "-af", "loudnorm=I=-18:TP=-3:LRA=9", "-ar", "48000", join(dir, "music-18.wav")]);
  const vo = FILMS[film].vo;
  const graph = [
    "[0:a]aformat=channel_layouts=stereo,asplit=2[vo][sc]",
    vo ? "[1:a][sc]sidechaincompress=threshold=0.035:ratio=5:attack=35:release=650:makeup=1:level_sc=1.6[bed]" : "[1:a]volume=1.0[bed];[sc]anullsink",
    "[2:a]volume=1.0[fx]",
    "[vo]volume=1.4[voa]",
    "[voa][bed][fx]amix=inputs=3:duration=first:normalize=0:dropout_transition=0[mixed]",
    `[mixed]loudnorm=I=${vo ? -16 : -18}:TP=-1.5:LRA=11[out]`,
  ].join(";");
  ff(["-i", join(dir, "vo.wav"), "-i", join(dir, "music-18.wav"), "-i", join(dir, "sfx.wav"), "-filter_complex", graph, "-map", "[out]", "-ar", "48000", join(dir, "mix.wav")]);
  console.log(`[mix] build/${film}/mix.wav`);
}

export function mux(film) {
  const dir = join(BUILD, film);
  for (const [src, dst] of [["video-1920x1080.mp4", `${film}.mp4`], ["video-1080x1080.mp4", `${film}-square.mp4`]]) {
    const v = join(dir, src);
    if (!existsSync(v)) { console.log(`[mux] skip ${dst}: ${src} not rendered`); continue; }
    ff(["-i", v, "-i", join(dir, "mix.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", join(ROOT, dst)]);
    console.log(`[mux] ${dst}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [film, ...flags] = process.argv.slice(2);
  if (!FILMS[film]) throw new Error(`usage: node src/audio.mjs <${Object.keys(FILMS).join("|")}> [--force] [--mux]`);
  if (flags.includes("--mux")) mux(film);
  else buildAudio(film, buildTimeline(film, { force: flags.includes("--force") }));
}
