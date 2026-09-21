import { execFileSync } from "node:child_process";
import fs from "node:fs";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const H = "C:/tech/ship/marketing/x/video/src/kinetic.html";
const PROF = "C:/tech/ship/marketing/x/_cliprof";
const FR = "C:/tech/ship/marketing/x/video/frames";
const FPS = 24;
const scenes = [
  ["open", 4.4], ["thesis", 4.4], ["loop", 7.8], ["receipts", 7.8], ["end", 4.8],
];
let total = 0;
for (const [s, d] of scenes) total += Math.round(d * FPS);
console.log("total frames", total);
let done = 0;
for (const [scene, dur] of scenes) {
  const dir = `${FR}/${scene}`;
  fs.mkdirSync(dir, { recursive: true });
  const n = Math.round(dur * FPS);
  for (let i = 0; i < n; i++) {
    const t = (i / FPS).toFixed(4);
    const out = `${dir}/f${String(i).padStart(4, "0")}.png`;
    execFileSync(CHROME, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--force-device-scale-factor=1", `--user-data-dir=${PROF}`,
      "--window-size=1920,1080", "--virtual-time-budget=900",
      `--screenshot=${out}`, `file:///${H}?scene=${scene}&t=${t}`,
    ], { stdio: "ignore", timeout: 30000 });
    done++;
    if (done % 40 === 0) console.log(`... ${done}/${total} (${scene} ${i + 1}/${n})`);
  }
  console.log(`scene ${scene} done (${n} frames)`);
}
console.log("ALL KINETIC FRAMES DONE", done);
