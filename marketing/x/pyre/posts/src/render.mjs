// Renders marketing/x/pyre/posts/visuals/NN-slug.png from cards.html?card=NN with headless Chrome.
// Usage (repo root): node marketing/x/pyre/posts/src/render.mjs [NN ...]
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, mkdirSync } from "node:fs";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SRC = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(SRC, "..", "visuals");
mkdirSync(OUT, { recursive: true });

// slugs in card order, read from the factory itself so names never drift
const html = readFileSync(resolve(SRC, "cards.html"), "utf8");
const slugs = [...html.matchAll(/\{ slug:"([a-z0-9-]+)"/g)].map((m) => m[1]);

const only = process.argv.slice(2).map(Number);
slugs.forEach((slug, i) => {
  const n = i + 1;
  if (only.length && !only.includes(n)) return;
  const nn = String(n).padStart(2, "0");
  const out = resolve(OUT, `${nn}-${slug}.png`);
  const url = `${pathToFileURL(resolve(SRC, "cards.html")).href}?card=${n}`;
  const r = spawnSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1600,900",
    "--virtual-time-budget=6000", `--screenshot=${out}`, url,
  ], { encoding: "utf8" });
  const last = (r.stderr || r.stdout || "").trim().split("\n").pop();
  console.log(`${nn}-${slug}.png — ${last}`);
});
