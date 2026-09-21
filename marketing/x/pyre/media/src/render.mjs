// Renders a film's stage frame-by-frame through one headless-Chrome CDP session,
// piping PNGs straight into ffmpeg.
//   node src/render.mjs <film>                 → build/<film>/video-1920x1080.mp4 (silent)
//   node src/render.mjs <film> --sq            → build/<film>/video-1080x1080.mp4
//   node src/render.mjs <film> --preview=0,5   → build/<film>/preview/<size>-t<sec>.png
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "../../video/src/cdp.mjs";
import { FILMS } from "./films.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const STAGE = pathToFileURL(join(ROOT, "src", "stage.html")).href;

const capMeta = () => {
  const out = {};
  const dir = join(BUILD, "cap");
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n, "meta.json");
    if (existsSync(p)) out[n] = JSON.parse(readFileSync(p, "utf8"));
  }
  return out;
};

async function openStage(film, { sq }) {
  const tl = JSON.parse(readFileSync(join(BUILD, film, "timeline.json"), "utf8"));
  for (const s of tl.shots) if (s.cap && !capMeta()[s.cap]) throw new Error(`${film}: capture "${s.cap}" missing — run src/capture.mjs ${s.cap}`);
  const width = sq ? 1080 : 1920, height = 1080;
  const page = await launch({ width, height });
  await page.goto(STAGE);
  await page.evaluate(`window.__init(${JSON.stringify({ tl, capMeta: capMeta(), sq })})`);
  return { page, width, height, tl };
}

export async function preview(film, times, { sq = false } = {}) {
  const { page, width, height } = await openStage(film, { sq });
  const dir = join(BUILD, film, "preview");
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

export async function render(film, { sq = false, crf = 17 } = {}) {
  const { page, width, height, tl } = await openStage(film, { sq });
  const out = join(BUILD, film, `video-${width}x${height}.mp4`);
  const total = Math.round(tl.duration * tl.fps);
  const ff = spawn("ffmpeg", [
    "-y", "-v", "error", "-f", "image2pipe", "-framerate", String(tl.fps), "-c:v", "png", "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-r", String(tl.fps), "-movflags", "+faststart", out,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const ffDone = new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`)))));
  const t0 = Date.now();
  try {
    for (let i = 0; i < total; i++) {
      await page.evaluate(`window.__seek(${i / tl.fps})`);
      const png = await page.screenshot();
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      if (i % 150 === 0 || i === total - 1) {
        const el = (Date.now() - t0) / 1000;
        console.log(`[render ${film} ${width}x${height}] ${i + 1}/${total}  ${el.toFixed(0)}s elapsed, ~${((total - i - 1) * (el / (i + 1))).toFixed(0)}s left`);
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
  const [film, ...args] = process.argv.slice(2);
  if (!FILMS[film]) throw new Error(`usage: node src/render.mjs <${Object.keys(FILMS).join("|")}> [--sq] [--preview=t,t]`);
  const sq = args.includes("--sq");
  const pv = args.find((a) => a.startsWith("--preview="));
  if (pv) await preview(film, pv.slice(10).split(",").map(Number), { sq });
  else await render(film, { sq });
}
