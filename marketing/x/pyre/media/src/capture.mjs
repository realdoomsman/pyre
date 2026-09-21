// Records real pages as 30 fps frame sequences through one headless-Chrome CDP
// session (same approach as ../../video/src/capture.mjs). Scroll, pointer and
// typed input are scripted per frame, so a re-run reproduces the same camera
// move over whatever the page shows that day.
//   node src/capture.mjs [segment ...]      → build/cap/<segment>/f0000.png … + meta.json
// Sources: prod (https://pyre.fun) for everything real; the coin page comes from
// the local vite + mock API (PYRE_MOCK_SITE, default http://localhost:5181) because
// no coin has launched — the stage stamps those frames "mock data".
// PYRE_SESSION (or build/session.json {token}) signs the launch capture in.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "../../video/src/cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "build", "cap");
const SITE = process.env.PYRE_SITE ?? "https://pyre.fun";
const MOCK = process.env.PYRE_MOCK_SITE ?? "http://localhost:5181";
const FPS = 30;
const W = 1920;
const H = 1080;

const sessionToken = () => {
  if (process.env.PYRE_SESSION) return process.env.PYRE_SESSION;
  const p = join(ROOT, "build", "session.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).token : null;
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, x) => a + (b - a) * x;
/** progress 0..1 over [a,b] of u, eased */
const span = (u, a, b, e = easeInOut) => e(clamp01((u - a) / (b - a)));
/** Piecewise path through keyframes [{at, ...values}] (at ∈ 0..1). */
const path = (keys) => (u) => {
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1].at) i++;
  const a = keys[i], b = keys[i + 1];
  const x = easeInOut(clamp01((u - a.at) / (b.at - a.at || 1)));
  const out = {};
  for (const k of Object.keys(a)) if (k !== "at") out[k] = lerp(a[k], b[k] ?? a[k], x);
  return out;
};

/** Rect of the nth element matching a selector (page coordinates for top). */
const rectJs = (sel, n = 0) =>
  `(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${n}];if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:r.top+window.scrollY,h:r.height,w:r.width,left:r.left}})()`;
/** Rect of the first element whose text starts with `text` among `sel` matches. */
const rectByTextJs = (sel, text) =>
  `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())}));if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:r.top+window.scrollY,h:r.height,w:r.width,left:r.left}})()`;
/** Set a React-controlled input/textarea value (native setter + input event). */
const setValueJs = (sel, n, value) =>
  `(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${n}];if(!e)return 0;const proto=e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const v=${JSON.stringify(value)};if(e.value===v)return 1;Object.getOwnPropertyDescriptor(proto,"value").set.call(e,v);e.dispatchEvent(new Event("input",{bubbles:true}));return 2})()`;
const typedPrefix = (text, u, a, b) => text.slice(0, Math.round(text.length * clamp01((u - a) / (b - a))));

const EXAMPLE = {
  name: "Deadline Radar",
  ticker: "RADAR",
  prompt: "a tool that watches public github repos and texts me the day before a release deadline slips.",
};

const SEGMENTS = {
  // Home: the empty hero, then a slow tilt down into "one loop. revenue closes it." — pointer walks 01…07.
  home: {
    url: "/", seconds: 7,
    async plan(page) {
      const loop = (await page.evaluate(rectJs("#loop-title"))) ?? { top: 1400 };
      const cells = [];
      for (let i = 0; i < 7; i++) cells.push((await page.evaluate(rectJs('[aria-labelledby="loop-title"] ol > li', i))) ?? { x: 700, top: loop.top + 120 + i * 90, h: 60 });
      const target = Math.max(0, Math.round(loop.top - 90));
      const scroll = (u) => Math.round(lerp(0, target, span(u, 0.18, 0.55)));
      return {
        scroll,
        mouse: (u) => {
          if (u < 0.5) return { x: 1560, y: 980 };
          const p = clamp01((u - 0.55) / 0.42) * 6;
          const a = cells[Math.floor(p)], b = cells[Math.min(6, Math.ceil(p))], f = p - Math.floor(p);
          return { x: lerp(a.x, b.x, f) - 120, y: lerp(a.top, b.top, f) - scroll(u) + a.h * 0.4 };
        },
      };
    },
  },
  // Launch, signed in: type an example coin into tray 01 (the live preview follows), then drift to the CTA. No click.
  launch: {
    url: "/launch", seconds: 8, session: true,
    async plan(page) {
      const name = (await page.evaluate(rectByTextJs("label", "name"))) ?? { x: 430, y: 300 };
      const ticker = (await page.evaluate(rectByTextJs("label", "ticker"))) ?? { x: 760, y: 300 };
      const prompt = (await page.evaluate(rectJs("textarea"))) ?? { x: 600, y: 580 };
      const cta = (await page.evaluate(rectByTextJs("button", "draft the agent brief"))) ?? { x: 830, y: 760 };
      const tab2 = (await page.evaluate(rectByTextJs('[role="tab"], button', "02"))) ?? { x: 370, y: 200 };
      const inputs = 'main input[type="text"], main input:not([type])';
      return {
        scroll: () => 0,
        mouse: path([
          { at: 0, x: 1500, y: 900 }, { at: 0.08, x: name.x, y: name.y + 40 }, { at: 0.3, x: name.x, y: name.y + 40 },
          { at: 0.34, x: ticker.x, y: ticker.y + 40 }, { at: 0.44, x: ticker.x, y: ticker.y + 40 },
          { at: 0.48, x: prompt.x, y: prompt.y }, { at: 0.84, x: prompt.x, y: prompt.y },
          { at: 0.92, x: tab2.x, y: tab2.y }, { at: 1, x: cta.x, y: cta.y },
        ]),
        async each(u) {
          await page.evaluate(setValueJs(inputs, 0, typedPrefix(EXAMPLE.name, u, 0.1, 0.28)));
          await page.evaluate(setValueJs(inputs, 1, typedPrefix(EXAMPLE.ticker, u, 0.35, 0.43)));
          await page.evaluate(setValueJs("textarea", 0, typedPrefix(EXAMPLE.prompt, u, 0.5, 0.84)));
        },
      };
    },
  },
  // Coin page (mock): market cap and chart, then tilt to "the loop" panel and walk its six cells; the kiln rides in on the right.
  coin: {
    site: MOCK, url: "/c/inbox-zero", seconds: 8,
    async plan(page) {
      const panel = (await page.evaluate(rectJs('[aria-label="Loop status"]'))) ?? { top: 800, h: 220 };
      const cells = [];
      for (let i = 0; i < 6; i++) cells.push((await page.evaluate(rectJs('[aria-label="Loop status"] ol > li', i))) ?? { x: 340 + i * 165, top: panel.top + 120, h: 100 });
      const s1 = Math.max(0, Math.round(panel.top - 300));
      const scroll = (u) => Math.round(lerp(0, s1, span(u, 0.22, 0.5)));
      return {
        scroll,
        mouse: (u) => {
          if (u < 0.45) return { x: 1500, y: 1000 };
          const p = clamp01((u - 0.5) / 0.45) * 5;
          const a = cells[Math.floor(p)], b = cells[Math.min(5, Math.ceil(p))], f = p - Math.floor(p);
          return { x: lerp(a.x, b.x, f), y: lerp(a.top, b.top, f) - scroll(u) + a.h * 0.5 };
        },
      };
    },
  },
  // Burn ledger, empty: hold on the header numbers, tilt down to the empty table.
  burns: {
    url: "/burns", seconds: 5,
    async plan(page) {
      const empty = (await page.evaluate(rectByTextJs("main h2, main h3, main p", "no burns yet"))) ?? { top: 760 };
      const s1 = Math.max(0, Math.round(empty.top - 560));
      return { scroll: (u) => Math.round(lerp(0, s1, span(u, 0.3, 0.8))), mouse: () => ({ x: 1600, y: 1000 }) };
    },
  },
  // /_ui — design system sections. The kiln segment clicks "Burn 10%" three times so layers hollow on camera.
  "ui-hero": { url: "/_ui", seconds: 5, async plan() { return { scroll: (u) => Math.round(lerp(0, 60, span(u, 0, 1))), mouse: () => ({ x: 1700, y: 1000 }) }; } },
  "ui-color": {
    url: "/_ui", seconds: 6,
    async plan(page) {
      const sec = (await page.evaluate(rectJs("#color"))) ?? { top: 900, h: 600 };
      const s0 = Math.max(0, Math.round(sec.top - 60)), s1 = s0 + Math.max(0, Math.round(sec.h - 700));
      const scroll = (u) => Math.round(lerp(s0, s1, span(u, 0.15, 0.9)));
      const ramp = (await page.evaluate(rectByTextJs("#color *", "heat ramp"))) ?? { top: sec.top + sec.h - 160 };
      return { scroll, mouse: (u) => ({ x: lerp(500, 1300, span(u, 0.5, 0.95)), y: ramp.top - scroll(u) + 80 }) };
    },
  },
  "ui-type": {
    url: "/_ui", seconds: 6,
    async plan(page) {
      const sec = (await page.evaluate(rectJs("#type"))) ?? { top: 1600, h: 700 };
      const s0 = Math.max(0, Math.round(sec.top - 60));
      return { scroll: (u) => Math.round(lerp(s0, s0 + 140, span(u, 0.1, 1))), mouse: () => ({ x: 1700, y: 1000 }) };
    },
  },
  "ui-kiln": {
    url: "/_ui", seconds: 7,
    async plan(page) {
      const sec = (await page.evaluate(rectJs("#kiln"))) ?? { top: 4600, h: 500 };
      const s0 = Math.max(0, Math.round(sec.top - 80));
      const btn = (await page.evaluate(rectByTextJs("#kiln button", "burn 10%"))) ?? { x: 1000, top: sec.top + 300, h: 32 };
      const first = (await page.evaluate(rectJs("#kiln svg", 0))) ?? { x: 500, top: sec.top + 200, h: 300 };
      const clicks = [0.3, 0.5, 0.7];
      let done = 0;
      const scroll = () => s0;
      return {
        scroll,
        mouse: (u) => (u < 0.22 ? { x: first.x, y: first.top - s0 + first.h * 0.35 } : { x: btn.x, y: btn.top - s0 + btn.h / 2 }),
        async each(u) {
          if (done < clicks.length && u >= clicks[done]) {
            done++;
            const x = Math.round(btn.x), y = Math.round(btn.top - s0 + btn.h / 2);
            await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
            await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          }
        },
      };
    },
  },
  "ui-motion": {
    url: "/_ui", seconds: 6,
    async plan(page) {
      const num = (await page.evaluate(rectJs("#numbers"))) ?? { top: 3600, h: 500 };
      const heat = (await page.evaluate(rectJs("#heat"))) ?? { top: num.top + 520, h: 500 };
      const s0 = Math.max(0, Math.round(num.top - 60)), s1 = Math.max(0, Math.round(heat.top - 80));
      const scroll = (u) => Math.round(lerp(s0, s1, span(u, 0.45, 0.8)));
      const slider = (await page.evaluate(rectJs('#heat input[type="range"]'))) ?? null;
      return {
        scroll,
        mouse: (u) => (slider ? { x: lerp(slider.left + 10, slider.left + slider.w - 10, span(u, 0.82, 1)), y: slider.top - scroll(u) + slider.h / 2 } : { x: 1700, y: 1000 }),
        async each(u) {
          if (slider && u >= 0.82) {
            const v = Math.round(lerp(20, 95, span(u, 0.82, 1)));
            await page.evaluate(`(()=>{const e=document.querySelector('#heat input[type="range"]');if(!e)return;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,${v});e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()`);
          }
        },
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
      const site = seg.site ?? SITE;
      let sessionScript = null;
      if (seg.session) {
        const token = sessionToken();
        if (!token) throw new Error(`${name}: needs PYRE_SESSION or build/session.json`);
        sessionScript = (await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("pyre_session",${JSON.stringify(token)})}catch{}` })).identifier;
      }
      await page.goto(site + seg.url, 6500);
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
        if (plan.each) await plan.each(u);
        await page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
        writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.png`), await page.screenshot());
      }
      if (sessionScript) {
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: sessionScript });
        await page.evaluate(`localStorage.removeItem("pyre_session"); 1`);
      }
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ frames: n, fps: FPS, width: W, height: H, site, url: seg.url, seconds: seg.seconds, capturedAt: new Date().toISOString() }));
      console.log(`[capture] ${name}: ${n} frames from ${site}${seg.url} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
