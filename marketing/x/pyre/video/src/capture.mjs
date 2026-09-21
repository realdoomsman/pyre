// Records the live site (https://pyre.fun) as 30 fps frame sequences through one
// headless-Chrome CDP session. Scroll and pointer are scripted per frame so a
// re-run produces the same camera move; page content is whatever is live.
//   node src/capture.mjs [segment ...]      → build/cap/<segment>/f0000.png …
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "build", "cap");
const SITE = process.env.PYRE_SITE ?? "https://pyre.fun";
const FPS = 30;
const W = 1920;
const H = 1080;

const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, x) => a + (b - a) * x;
/** Piecewise path through keyframes [{at, ...values}] (at ∈ 0..1). */
const path = (keys) => (u) => {
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1].at) i++;
  const a = keys[i], b = keys[i + 1];
  const x = easeInOut(Math.min(1, Math.max(0, (u - a.at) / (b.at - a.at || 1))));
  const out = {};
  for (const k of Object.keys(a)) if (k !== "at") out[k] = lerp(a[k], b[k] ?? a[k], x);
  return out;
};

/** Rect helper evaluated in-page: centre of the nth element matching a selector. */
const centerJs = (sel, n = 0) =>
  `(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${n}];if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:r.top+window.scrollY,h:r.height,w:r.width,left:r.left}})()`;

const SEGMENTS = {
  // /launch hero: pointer drifts onto the live preview card, then the CTA.
  launch: {
    url: "/launch",
    seconds: 3.5,
    async plan(page) {
      const card = (await page.evaluate(centerJs("main section, main [class*=rounded]", 0))) ?? { x: 1180, y: 190 };
      const cta = (await page.evaluate(centerJs("main button, main a[href*=sign]", 0))) ?? { x: 500, y: 308 };
      return { scroll: () => 0, mouse: path([{ at: 0, x: 1500, y: 700 }, { at: 0.45, x: card.x + 40, y: card.y + 20 }, { at: 0.7, x: card.x + 40, y: card.y + 20 }, { at: 1, x: cta.x, y: cta.y }]) };
    },
  },
  // Home feed: slow scroll so the ranked cards sit high, pointer sweeps the three cards.
  home: {
    url: "/",
    seconds: 4.5,
    async plan(page) {
      const feed = (await page.evaluate(centerJs('[aria-label="Ranked feed"]'))) ?? { top: 480 };
      const targetScroll = Math.max(0, Math.round(feed.top - 120));
      const cards = [];
      for (let i = 0; i < 3; i++) cards.push((await page.evaluate(centerJs('[aria-label="Ranked feed"] article, [aria-label="Ranked feed"] a[aria-label]', i))) ?? { x: 430 + i * 355, y: 640, top: 600 });
      return {
        scroll: (u) => Math.round(lerp(0, targetScroll, easeInOut(Math.min(1, u / 0.55)))),
        mouse: (u) => {
          const s = Math.round(lerp(0, targetScroll, easeInOut(Math.min(1, u / 0.55))));
          const p = path([{ at: 0, i: -1 }, { at: 0.3, i: -1 }, { at: 0.45, i: 0 }, { at: 0.62, i: 0 }, { at: 0.72, i: 1 }, { at: 0.88, i: 1 }, { at: 1, i: 2 }])(u).i;
          if (p < 0) return { x: 1700, y: 1000 };
          const a = cards[Math.max(0, Math.floor(p))], b = cards[Math.min(2, Math.ceil(p))], f = p - Math.floor(p);
          return { x: lerp(a.x, b.x, f), y: lerp(a.top, b.top, f) - s + 90 };
        },
      };
    },
  },
  // Coin page, "The loop" panel: pointer walks the six cells.
  loop: {
    url: "/c/inboxzero",
    seconds: 4.5,
    async plan(page) {
      const panel = (await page.evaluate(centerJs('[aria-label="Loop status"]'))) ?? { top: 820, h: 220 };
      const cells = [];
      for (let i = 0; i < 6; i++) cells.push((await page.evaluate(centerJs('[aria-label="Loop status"] ol > li', i))) ?? { x: 270 + i * 165, top: panel.top + 120 });
      const s0 = Math.max(0, Math.round(panel.top - 420)), s1 = Math.max(0, Math.round(panel.top - 300));
      const scroll = (u) => Math.round(lerp(s0, s1, easeInOut(u)));
      return {
        scroll,
        mouse: (u) => {
          const p = Math.min(5, Math.max(0, (u - 0.15) / 0.8) * 5.999);
          const a = cells[Math.floor(p)], b = cells[Math.min(5, Math.ceil(p))], f = p - Math.floor(p);
          return { x: lerp(a.x, b.x, f), y: lerp(a.top, b.top, f) - scroll(u) + 60 };
        },
      };
    },
  },
  // Coin page, supply kiln: hover the top layers so the burn tooltip appears.
  kiln: {
    url: "/c/inboxzero",
    seconds: 4,
    async plan(page) {
      const card = (await page.evaluate(centerJs('[aria-label="Supply kiln"]'))) ?? { top: 1000, h: 430 };
      const layers = [];
      for (let i = 0; i < 4; i++) layers.push((await page.evaluate(centerJs('[aria-label="Supply kiln"] [data-layer]', 11 - i))) ?? { x: 1050, top: card.top + 140 + i * 28 });
      const s0 = Math.max(0, Math.round(card.top - 330)), s1 = Math.max(0, Math.round(card.top - 250));
      const scroll = (u) => Math.round(lerp(s0, s1, easeInOut(u)));
      return {
        scroll,
        mouse: (u) => {
          const p = Math.min(3, Math.max(0, (u - 0.2) / 0.7) * 3.2);
          const a = layers[Math.floor(p)], b = layers[Math.min(3, Math.ceil(p))], f = p - Math.floor(p);
          return { x: lerp(a.x, b.x, f), y: lerp(a.top, b.top, f) - scroll(u) + (a.h ?? 20) / 2 };
        },
      };
    },
  },
  // Coin page, fee transparency table (right column, below the stats card).
  fees: {
    url: "/c/inboxzero",
    seconds: 4,
    async plan(page) {
      const card = (await page.evaluate(centerJs('[aria-label="Fee transparency"], section:has(> * > [class*=eyebrow]):last-of-type'))) ?? { top: 1740, h: 440, x: 1120 };
      const s0 = Math.max(0, Math.round(card.top - 420)), s1 = Math.max(0, Math.round(card.top - 300));
      const scroll = (u) => Math.round(lerp(s0, s1, easeInOut(u)));
      return {
        scroll,
        mouse: (u) => ({ x: card.x, y: card.top - scroll(u) + 120 + easeInOut(Math.min(1, Math.max(0, (u - 0.3) / 0.6))) * 260 }),
      };
    },
  },
  // Burn ledger: chart, then a slow tilt down into the table; pointer rides the rows.
  burns: {
    url: "/burns",
    seconds: 5,
    async plan(page) {
      const table = (await page.evaluate(centerJs("main table"))) ?? { top: 640, x: 960 };
      const s1 = Math.max(0, Math.round(table.top - 400));
      const scroll = (u) => Math.round(lerp(0, s1, easeInOut(Math.min(1, Math.max(0, (u - 0.25) / 0.55)))));
      return {
        scroll,
        mouse: (u) => ({ x: 700, y: table.top - scroll(u) + 60 + easeInOut(Math.min(1, Math.max(0, (u - 0.5) / 0.5))) * 280 }),
      };
    },
  },
};

export async function capture(names = Object.keys(SEGMENTS)) {
  const page = await launch({ width: W, height: H });
  try {
    for (const name of names) {
      const seg = SEGMENTS[name];
      if (!seg) throw new Error(`unknown segment ${name}`);
      const dir = join(OUT, name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      await page.goto(SITE + seg.url, 6500);
      await page.evaluate(`document.documentElement.style.scrollBehavior='auto';document.body.style.cursor='none';1`);
      const plan = await seg.plan(page);
      const n = Math.round(seg.seconds * FPS);
      const t0 = Date.now();
      for (let i = 0; i < n; i++) {
        const u = n === 1 ? 0 : i / (n - 1);
        const y = plan.scroll(u);
        const m = plan.mouse(u);
        await page.evaluate(`window.scrollTo(0, ${y}); ${y}`);
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(m.x), y: Math.round(m.y) });
        // let the page apply hover styles / scroll-linked layout before the grab
        await page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
        writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.png`), await page.screenshot());
      }
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ frames: n, fps: FPS, width: W, height: H, url: seg.url, seconds: seg.seconds }));
      console.log(`[capture] ${name}: ${n} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    if (page.logs.length) console.log(page.logs.slice(0, 10).join("\n"));
  } finally {
    page.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const names = process.argv.slice(2);
  await capture(names.length ? names : undefined);
  await sleep(300);
}
