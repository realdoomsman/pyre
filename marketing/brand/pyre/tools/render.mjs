// Renders every PNG in marketing/brand/pyre from its HTML source with headless Chrome.
// Usage (from repo root): node marketing/brand/pyre/tools/render.mjs [name ...]
//   e.g. node marketing/brand/pyre/tools/render.mjs banner og
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = {
  "pfp": [1024, 1024],
  "pfp-alt": [1024, 1024],
  "banner": [1500, 500],
  "banner-safe-preview": [1500, 500],
  "og": [1200, 630],
  "apple-touch-icon": [180, 180],
  "icon-192": [192, 192, "--default-background-color=00000000"],
  "icon-512": [512, 512, "--default-background-color=00000000"],
};

const names = process.argv.slice(2);
for (const [name, [w, h, ...extra]] of Object.entries(TARGETS)) {
  if (names.length && !names.includes(name)) continue;
  const out = resolve(DIR, `${name}.png`);
  const url = pathToFileURL(resolve(DIR, `${name}.html`)).href;
  const r = spawnSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    `--window-size=${w},${h}`, "--virtual-time-budget=5000", ...extra,
    `--screenshot=${out}`, url,
  ], { encoding: "utf8" });
  const last = (r.stderr || r.stdout || "").trim().split("\n").pop();
  console.log(`${name}.png ${w}x${h} — ${last}`);
}
