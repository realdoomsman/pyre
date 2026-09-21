// QA: ffprobe facts plus a frame every 5 s (and a contact sheet) for each deliverable.
//   node src/qa.mjs [film ...]      → build/qa/<name>-NN.png, build/qa/<name>-sheet.png
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FILMS } from "./films.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QA = join(ROOT, "build", "qa");

export function qa(films = Object.keys(FILMS)) {
  mkdirSync(QA, { recursive: true });
  const rows = [];
  for (const film of films) {
    for (const name of [`${film}.mp4`, `${film}-square.mp4`]) {
      const file = join(ROOT, name);
      if (!existsSync(file)) { console.log(`[qa] missing ${name}`); continue; }
      const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels", "-of", "json", file]).toString());
      const mb = statSync(file).size / 1048576;
      const v = j.streams.find((s) => s.codec_type === "video"), a = j.streams.find((s) => s.codec_type === "audio");
      const dur = +j.format.duration;
      const ok = v?.codec_name === "h264" && a?.codec_name === "aac" && dur >= 15 && dur <= 30 && mb <= 40;
      rows.push({ name, dur: +dur.toFixed(2), mb: +mb.toFixed(1), video: `${v.codec_name} ${v.width}x${v.height} ${v.pix_fmt} ${v.r_frame_rate}`, audio: `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch`, ok });
      const base = name.replace(".mp4", "");
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", "fps=1/5", join(QA, `${base}-%02d.png`)]);
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", `fps=1/5,scale=${v.width > 1200 ? 640 : 480}:-1,tile=3x2:padding=6:margin=6:color=0x0A0A0C`, "-frames:v", "1", "-update", "1", join(QA, `${base}-sheet.png`)]);
    }
  }
  for (const r of rows) console.log(`[qa] ${r.ok ? "ok " : "BAD"} ${r.name}: ${r.dur}s · ${r.mb} MB · ${r.video} · ${r.audio}`);
  console.log(`[qa] frames → build/qa/<name>-NN.png · sheets → build/qa/<name>-sheet.png`);
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) qa(process.argv.slice(2).length ? process.argv.slice(2) : undefined);
