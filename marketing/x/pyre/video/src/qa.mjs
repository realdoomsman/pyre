// QA: pull a frame every 5 s from each deliverable into build/qa/ plus a contact
// sheet, and print ffprobe facts. Read the sheets; fix what looks wrong.
//   node src/qa.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, OUT } from "./film.mjs";

const QA = join(ROOT, "build", "qa");

export function qa() {
  mkdirSync(QA, { recursive: true });
  for (const name of [`${OUT}.mp4`, `${OUT}-square.mp4`]) {
    const file = join(ROOT, name);
    if (!existsSync(file)) { console.log(`[qa] missing ${name}`); continue; }
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels", "-of", "json", file]).toString();
    const j = JSON.parse(probe);
    const mb = (statSync(file).size / 1048576).toFixed(1);
    console.log(`[qa] ${name}: ${(+j.format.duration).toFixed(2)}s · ${mb} MB · ` + j.streams.map((s) => s.codec_type === "video" ? `${s.codec_name} ${s.width}x${s.height} ${s.pix_fmt} ${s.r_frame_rate}` : `${s.codec_name} ${s.sample_rate}Hz ${s.channels}ch`).join(" · "));
    const base = name.replace(".mp4", "");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", "fps=1/5", join(QA, `${base}-%02d.png`)]);
    const w = j.streams.find((s) => s.codec_type === "video").width;
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", `fps=1/5,scale=${w > 1200 ? 640 : 480}:-1,tile=4x4:padding=6:margin=6:color=0x0A0A0C`, "-frames:v", "1", "-update", "1", join(QA, `${base}-sheet.png`)]);
    console.log(`[qa] frames → build/qa/${base}-NN.png · sheet → build/qa/${base}-sheet.png`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) qa();
