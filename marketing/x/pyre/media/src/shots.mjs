// The eight real screenshots (1600×900) for the image posts, from prod after the
// purge, plus the two diagram cards from cards.html.
//   node src/shots.mjs [name ...]            → img/NN-<name>.png
// Signed-in shots (launch, me) need PYRE_SESSION or build/session.json {token}.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, sleep, CHROME } from "../../video/src/cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "img");
const SITE = process.env.PYRE_SITE ?? "https://pyre.fun";
const W = 1600, H = 900;

const sessionToken = () => {
  if (process.env.PYRE_SESSION) return process.env.PYRE_SESSION;
  const p = join(ROOT, "build", "session.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).token : null;
};
const clickText = (sel, text) =>
  `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.trim().toLowerCase()===${JSON.stringify(text.toLowerCase())});if(!e)return false;e.click();return true})()`;
const settle = "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";

const SHOTS = {
  "home-empty": { url: "/" },
  "launch-step1": { url: "/launch", session: true },
  "burns-empty": { url: "/burns" },
  "pyre-prelaunch": { url: "/pyre" },
  "me-deposit": {
    url: "/me", session: true,
    async act(page) {
      if (!(await page.evaluate(clickText("button", "deposit")))) throw new Error("me: Deposit button not found");
      await sleep(900);
    },
  },
  "status-live": { url: "/status" },
  "palette": {
    url: "/",
    async act(page) {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "k", code: "KeyK", modifiers: 2, windowsVirtualKeyCode: 75 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", modifiers: 2, windowsVirtualKeyCode: 75 });
      await sleep(700);
    },
  },
  "mobile-home": { url: "/", mobile: true },
};

async function shoot(names) {
  mkdirSync(OUT, { recursive: true });
  const keys = Object.keys(SHOTS);
  for (const name of names) {
    const s = SHOTS[name];
    if (!s) throw new Error(`unknown shot ${name}`);
    const nn = String(keys.indexOf(name) + 1).padStart(2, "0");
    const out = join(OUT, `${nn}-${name}.png`);
    const page = s.mobile ? await launch({ width: 390, height: 844 }) : await launch({ width: W, height: H });
    try {
      if (s.session) {
        const token = sessionToken();
        if (!token) throw new Error(`${name}: needs PYRE_SESSION or build/session.json`);
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("pyre_session",${JSON.stringify(token)})}catch{}` });
      }
      await page.goto(SITE + s.url, 4500);
      await page.evaluate(`document.body.style.cursor='none';1`);
      if (s.act) await s.act(page);
      await page.evaluate(settle);
      const png = await page.screenshot();
      if (s.mobile) {
        writeFileSync(join(ROOT, "build", "mobile-raw.png"), png);
        await frame(join(ROOT, "build", "mobile-raw.png"), out);
      } else writeFileSync(out, png);
      console.log(`[shot] ${out}`);
    } finally {
      page.close();
      await sleep(200);
    }
  }
}

/** Composite the 390×844 mobile capture into a phone outline on a 1600×900 obsidian card. */
async function frame(raw, out) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:#0A0A0C}
    .stage{position:relative;width:1600px;height:900px;overflow:hidden;background:#0A0A0C;font-family:Geist,system-ui,sans-serif}
    .heat{position:absolute;left:0;right:0;bottom:0;height:34%;opacity:.55;background:linear-gradient(180deg,transparent 0%,#1C1B2E 22%,#3B2F7A 46%,#7A66F5 66%,#3E8BFF 80%,#9CD2FF 92%,#E9F1FF 100%)}
    .heat::after{content:"";position:absolute;left:50%;bottom:0;width:140%;height:70%;transform:translateX(-50%);background:radial-gradient(ellipse at 50% 100%,rgba(233,241,255,.5),rgba(156,210,255,.25) 22%,rgba(62,139,255,.1) 45%,transparent 70%)}
    .phone{position:absolute;left:50%;top:60px;width:390px;height:844px;transform:translateX(-50%) scale(.92);transform-origin:top center;border-radius:44px;border:1.5px solid rgba(255,255,255,.16);background:#0A0A0C;box-shadow:0 40px 120px rgba(0,0,0,.7),inset 0 0 0 8px #121215;overflow:hidden}
    .phone img{position:absolute;left:8px;top:8px;width:374px;height:828px;object-fit:cover;object-position:top;border-radius:36px}
    .cap{position:absolute;left:64px;bottom:56px;font-family:"Geist Mono",monospace;font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:#9B9891}
    .cap b{display:block;font-family:"Instrument Serif",serif;font-weight:400;text-transform:none;letter-spacing:-.02em;font-size:44px;color:#F3F2EE;margin-bottom:10px}
    .cap b i{color:#9D8CFF}
    @font-face{font-family:"Instrument Serif";src:url("${pathToFileURL(join(ROOT, "..", "video", "src", "fonts", "InstrumentSerif-Regular.ttf")).href}")}
    @font-face{font-family:"Instrument Serif";src:url("${pathToFileURL(join(ROOT, "..", "video", "src", "fonts", "InstrumentSerif-Italic.ttf")).href}");font-style:italic}
    @font-face{font-family:"Geist Mono";src:url("${pathToFileURL(join(ROOT, "..", "video", "src", "fonts", "GeistMono-Variable.woff2")).href}") format("woff2");font-weight:100 900}
  </style><div class="stage"><div class="heat"></div>
    <div class="cap"><b>pyre.fun on a <i>phone</i>.</b>390 wide · live · nothing has launched yet</div>
    <div class="phone"><img src="${pathToFileURL(raw).href}"></div>
  </div>`;
  const page = join(ROOT, "build", "mobile-frame.html");
  writeFileSync(page, html);
  const r = spawnSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${W},${H}`, "--virtual-time-budget=4000", "--allow-file-access-from-files", `--screenshot=${out}`, pathToFileURL(page).href], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`frame: chrome exit ${r.status}\n${r.stderr}`);
}

/** The two diagram cards. */
export function cards(only = []) {
  mkdirSync(OUT, { recursive: true });
  const html = readFileSync(join(ROOT, "src", "cards.html"), "utf8");
  const slugs = [...html.matchAll(/\{ slug:"([a-z0-9-]+)"/g)].map((m) => m[1]);
  slugs.forEach((slug, i) => {
    if (only.length && !only.includes(slug)) return;
    const out = join(OUT, `${String(Object.keys(SHOTS).length + i + 1).padStart(2, "0")}-${slug}.png`);
    const url = `${pathToFileURL(join(ROOT, "src", "cards.html")).href}?card=${i + 1}`;
    const r = spawnSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${W},${H}`, "--virtual-time-budget=6000", `--screenshot=${out}`, url], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`card ${slug}: chrome exit ${r.status}`);
    console.log(`[card] ${out}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const names = process.argv.slice(2);
  const shots = names.filter((n) => SHOTS[n]);
  const only = names.filter((n) => !SHOTS[n]);
  if (!names.length || shots.length) await shoot(shots.length ? shots : Object.keys(SHOTS));
  if (!names.length || only.length) cards(only);
}
