// Mixes voice + music + sfx and muxes onto the silent renders.
//   build/vo.wav        voice (mono)
//   build/music.wav     bed, normalised to −18 LUFS then side-chain ducked by the voice
//   build/sfx.wav       whooshes / thump
// → build/mix.wav (loudnorm −16 LUFS, −1.5 dBTP), then
// → pyre-launch.mp4 (from build/video-1920x1080.mp4) and pyre-launch-square.mp4.
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const ff = (args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "inherit" });

export function mix() {
  // 1. music stem to −18 LUFS (two-pass loudnorm is overkill for a synthetic bed; linear mode is fine)
  ff(["-i", join(BUILD, "music.wav"), "-af", "loudnorm=I=-18:TP=-3:LRA=9", "-ar", "48000", join(BUILD, "music-18.wav")]);

  // 2. duck the bed under the voice, sum, normalise the bus
  const graph = [
    "[0:a]aformat=channel_layouts=stereo,asplit=2[vo][sc]",
    "[1:a][sc]sidechaincompress=threshold=0.035:ratio=5:attack=35:release=650:makeup=1:level_sc=1.6[bed]",
    "[2:a]volume=1.0[fx]",
    "[vo]volume=1.4[voa]",
    "[voa][bed][fx]amix=inputs=3:duration=first:normalize=0:dropout_transition=0[mixed]",
    "[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]",
  ].join(";");
  ff(["-i", join(BUILD, "vo.wav"), "-i", join(BUILD, "music-18.wav"), "-i", join(BUILD, "sfx.wav"), "-filter_complex", graph, "-map", "[out]", "-ar", "48000", join(BUILD, "mix.wav")]);
  console.log("[mix] build/mix.wav");
}

export function mux() {
  const outs = [
    ["video-1920x1080.mp4", "pyre-launch.mp4"],
    ["video-1080x1080.mp4", "pyre-launch-square.mp4"],
  ];
  for (const [src, dst] of outs) {
    const v = join(BUILD, src);
    if (!existsSync(v)) { console.log(`[mux] skip ${dst}: ${src} not rendered`); continue; }
    ff(["-i", v, "-i", join(BUILD, "mix.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", join(ROOT, dst)]);
    console.log(`[mux] ${dst}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mix();
  mux();
}
