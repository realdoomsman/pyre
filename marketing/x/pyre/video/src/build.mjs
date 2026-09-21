// One command, whole film:  node src/build.mjs [--skip=capture,voice] [--only=render,mix]
//
//   capture  record the live site as 30 fps frame sequences   (needs network; ~2 min)
//   voice    edge-tts per sentence → timeline.json, vo.wav, script.md, .srt
//   music    ambient bed → music.wav
//   sfx      whooshes + thump → sfx.wav
//   render   scenes.html → video-1920x1080.mp4 and video-1080x1080.mp4 (~10 min)
//   mix      duck, sum, loudnorm → mix.wav; mux → pyre-launch.mp4, pyre-launch-square.mp4
//   qa       frame every 5 s + contact sheets in build/qa/
//
// No npm. Needs: node ≥ 22, Chrome, ffmpeg/ffprobe on PATH, python with edge-tts.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const list = (flag) => (args.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3) ?? "").split(",").filter(Boolean);
const skip = new Set(list("skip"));
const only = new Set(list("only"));
const ORDER = ["capture", "voice", "music", "sfx", "render", "mix", "qa"];
const run = (step) => (only.size ? only.has(step) : !skip.has(step));

const t0 = Date.now();
const stamp = (s) => console.log(`\n── ${s} · ${((Date.now() - t0) / 1000).toFixed(0)}s ──`);

for (const step of ORDER) {
  if (!run(step)) continue;
  stamp(step);
  switch (step) {
    case "capture": {
      const { capture } = await import("./capture.mjs");
      await capture();
      break;
    }
    case "voice": {
      const { buildVoice } = await import("./voice.mjs");
      buildVoice({ force: args.includes("--force-voice") });
      break;
    }
    case "music": (await import("./music.mjs")).buildMusic(); break;
    case "sfx": (await import("./sfx.mjs")).buildSfx(); break;
    case "render": {
      if (!existsSync(join(ROOT, "build", "cap", "burns", "meta.json"))) throw new Error("no captures in build/cap — run without --skip=capture first");
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
