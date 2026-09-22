// One command, whole film:  node src/build.mjs [--film=launch|venues] [--skip=capture,voice] [--only=render,mix]
//
//   capture  record the live site as 30 fps frame sequences   (needs network; ~2 min)
//   voice    edge-tts per sentence → timeline.json, vo.wav, script.md, .srt
//   music    ambient bed → music.wav
//   sfx      whooshes + thump → sfx.wav
//   render   scenes.html → video-1920x1080.mp4 and video-1080x1080.mp4 (~10 min)
//   mix      duck, sum, loudnorm → mix.wav; mux → pyre-<film>.mp4, pyre-<film>-square.mp4
//   qa       frame every 5 s + contact sheets in build/qa/
//
// `--film` picks the script (src/script.mjs or src/script-<film>.mjs) and, for any film but
// `launch`, moves intermediates to build/<film>/ and deliverables to pyre-<film>.* (film.mjs).
// No npm. Needs: node ≥ 22, Chrome, ffmpeg/ffprobe on PATH, python with edge-tts.
import { existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const list = (flag) => (args.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3) ?? "").split(",").filter(Boolean);
const film = list("film")[0];
if (film) process.env.PYRE_FILM = film;
// film.mjs reads the env at import time, so it (and everything importing it) loads after the flag is applied
const { BUILD, CAP, FILM, script } = await import("./film.mjs");
const { readJson } = await import("./wav.mjs");
const { CAPTURES } = await script();
const tl = () => readJson(join(BUILD, "timeline.json"));
const skip = new Set(list("skip"));
const only = new Set(list("only"));
const ORDER = ["capture", "voice", "music", "sfx", "render", "mix", "qa"];
const run = (step) => (only.size ? only.has(step) : !skip.has(step));

const t0 = Date.now();
const stamp = (s) => console.log(`\n── ${s} · ${((Date.now() - t0) / 1000).toFixed(0)}s ──`);
console.log(`film: ${FILM}`);

for (const step of ORDER) {
  if (!run(step)) continue;
  stamp(step);
  switch (step) {
    case "capture": {
      const { capture } = await import("./capture.mjs");
      await capture(CAPTURES);
      break;
    }
    case "voice": {
      const { buildVoice } = await import("./voice.mjs");
      buildVoice({ force: args.includes("--force-voice") });
      break;
    }
    case "music": (await import("./music.mjs")).buildMusic({ tl: tl(), out: join(BUILD, "music.wav") }); break;
    case "sfx": (await import("./sfx.mjs")).buildSfx({ tl: tl(), out: join(BUILD, "sfx.wav") }); break;
    case "render": {
      const missing = CAPTURES.filter((n) => !existsSync(join(CAP, n, "meta.json")));
      if (missing.length) throw new Error(`no captures for ${missing.join(", ")} in build/cap — run without --skip=capture first`);
      const { render } = await import("./render.mjs");
      if (!args.includes("--square-only")) await render({ sq: false });
      if (!args.includes("--wide-only")) await render({ sq: true });
      break;
    }
    case "mix": {
      const m = await import("./mix.mjs");
      m.mix();
      m.mux();
      break;
    }
    case "qa": (await import("./qa.mjs")).qa(); break;
  }
}
stamp("done");
