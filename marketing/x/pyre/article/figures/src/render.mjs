// node marketing/x/pyre/article/figures/src/render.mjs [name ...]  → figures/NN-name.png at 1600×900
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = dirname(fileURLToPath(import.meta.url));
const out = resolve(src, "..");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const only = process.argv.slice(2);
for (const f of readdirSync(src).filter((f) => f.endsWith(".html"))) {
  const name = f.replace(/\.html$/, "");
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const png = resolve(out, `${name}.png`);
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1600,900", "--virtual-time-budget=6000", `--screenshot=${png}`, `file:///${resolve(src, f).replace(/\\/g, "/")}`], { stdio: "ignore" });
  console.log(`[fig] ${png}`);
}
