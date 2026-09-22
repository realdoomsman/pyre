// Renders scenes.html frame-by-frame through one headless-Chrome CDP session,
// piping PNGs straight into ffmpeg (no frame files on disk).
//   node src/render.mjs                → build/video-1920x1080.mp4 (silent)
//   node src/render.mjs --sq           → build/video-1080x1080.mp4
//   node src/render.mjs --preview=0,5,10   → build/preview/<size>-t<sec>.png (no video)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";
import { ROOT, BUILD, CAP, FILM } from "./film.mjs";

const SCENES = pathToFileURL(join(ROOT, "src", "scenes.html")).href;

/** meta.json of every capture segment in the shared pool (frame counts for the scene clock). */
const capMeta = () => {
  const out = {};
  if (!existsSync(CAP)) return out;
  for (const n of readdirSync(CAP)) {
    const p = join(CAP, n, "meta.json");
    if (existsSync(p)) out[n] = JSON.parse(readFileSync(p, "utf8"));
  }
  return out;
};

async function openStage({ sq }) {
  const width = sq ? 1080 : 1920, height = 1080;
  const page = await launch({ width, height });
  await page.goto(`${SCENES}?film=${FILM}&sq=${sq ? 1 : 0}`);
  await page.evaluate("window.__ready");
  await page.evaluate(`window.__setCapMeta(${JSON.stringify(capMeta())}); 1`);
  return { page, width, height };
}

export async function preview(times, { sq = false } = {}) {
  const { page, width, height } = await openStage({ sq });
  const dir = join(BUILD, "preview");
  mkdirSync(dir, { recursive: true });
  try {
    for (const t of times) {
      const info = await page.evaluate(`window.__seek(${t})`);
      const out = join(dir, `${width}x${height}-t${String(t).padStart(5, "0")}.png`);
      writeFileSync(out, await page.screenshot());
      console.log(`[preview] ${out} ${info.shot} +${info.local}s`);
    }
    if (page.logs.length) console.log(page.logs.join("\n"));
  } finally {
    page.close();
  }
}

export async function render({ sq = false, crf = 16 } = {}) {
  const tl = JSON.parse(readFileSync(join(BUILD, "timeline.json"), "utf8"));
  const { page, width, height } = await openStage({ sq });
  const out = join(BUILD, `video-${width}x${height}.mp4`);
  const total = Math.round(tl.duration * tl.fps);
  const ff = spawn("ffmpeg", [
    "-y", "-v", "error", "-f", "image2pipe", "-framerate", String(tl.fps), "-c:v", "png", "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-r", String(tl.fps), "-movflags", "+faststart", out,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const ffDone = new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`)))));
  const t0 = Date.now();
  try {
    for (let i = 0; i < total; i++) {
      const t = i / tl.fps;
      await page.evaluate(`window.__seek(${t})`);
      const png = await page.screenshot();
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      if (i % 150 === 0 || i === total - 1) {
        const el = (Date.now() - t0) / 1000;
        console.log(`[render ${width}x${height}] ${i + 1}/${total}  ${el.toFixed(0)}s elapsed, ~${((total - i - 1) * (el / (i + 1))).toFixed(0)}s left`);
      }
    }
    if (page.logs.length) console.log(page.logs.join("\n"));
  } finally {
    ff.stdin.end();
    page.close();
  }
  await ffDone;
  console.log(`[render] ${out}`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const sq = args.includes("--sq");
  const pv = args.find((a) => a.startsWith("--preview="));
  if (pv) await preview(pv.slice(10).split(",").map(Number), { sq });
  else await render({ sq });
}
