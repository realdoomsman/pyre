// Tiles a directory of PNGs into one contact sheet (Windows ffmpeg has no glob input).
//   node src/tile.mjs <dir> <out.png> [cols=3] [width=640]
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [dir, out, cols = "3", width = "640"] = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith(".png")).sort((a, b) => (parseFloat(a.replace(/^.*-t/, "")) || 0) - (parseFloat(b.replace(/^.*-t/, "")) || 0) || a.localeCompare(b));
const rows = Math.ceil(files.length / Number(cols));
const list = join(tmpdir(), `tile-${Date.now()}.txt`);
writeFileSync(list, files.map((f) => `file '${resolve(dir, f).replace(/\\/g, "/")}'\nduration 1`).join("\n") + "\n");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `scale=${width}:-1,tile=${cols}x${rows}:padding=4:margin=4:color=0x0A0A0C`, "-frames:v", "1", "-update", "1", out], { stdio: "inherit" });
console.log(`[tile] ${files.length} frames → ${out} (${cols}×${rows})`);
