// Records the live site (https://pyre.fun) as 30 fps frame sequences through one
// headless-Chrome CDP session. Scroll and pointer are scripted per frame so a
// re-run produces the same camera move; page content is whatever is live.
//   node src/capture.mjs [segment ...]      → build/cap/<segment>/f0000.png …
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";
import { CAP as OUT } from "./film.mjs";

const SITE = process.env.PYRE_SITE ?? "https://pyre.fun";
// No coin has launched on prod, so coin-page segments come from the local vite + mock API
// (start `node .tmp/mock-api.mjs` and `VITE_API_ORIGIN=http://localhost:8787 npx vite --port 5181` in apps/web).
// scenes.html stamps those shots "mock data · no coin has launched yet".
const MOCK = process.env.PYRE_MOCK_SITE ?? "http://localhost:5181";
// The venues film shoots the staging deployment, where the Solana venue is live on devnet.
// Signed-in pages (`session: true`) get a staging session token from PYRE_STAGING_SESSION_FILE
// written to localStorage.pyre_session before navigation.
const STAGING = process.env.PYRE_STAGING_SITE ?? "https://web-staging-4bd4.up.railway.app";
const SESSION_FILE = process.env.PYRE_STAGING_SESSION_FILE ?? "C:/tech/ship/.tmp/staging-session.txt";
/** Production launch stake on Solana (packages/shared LAUNCH_STAKE_BY_CHAIN). Staging's devnet
 *  config asks 0.1 SOL; the picker capture rewrites /v1/venues to the production figure so the
 *  screen matches what ships ("stake 1 SOL") — the only patched value in any capture. */
const SOL_STAKE_LAMPORTS = "1000000000";
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

const rectJs = (expr) => `(()=>{const e=${expr};if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:r.top+window.scrollY,h:r.height,w:r.width,left:r.left}})()`;
/** Rect helper evaluated in-page: centre of the nth element matching a selector. */
const centerJs = (sel, n = 0) => rectJs(`document.querySelectorAll(${JSON.stringify(sel)})[${n}]`);
/** Rect of the smallest element whose text starts with `text` (chips, buttons, labels the DOM has no hook for). */
const textJs = (text) =>
  rectJs(`Array.from(document.querySelectorAll('main *, [role=dialog] *')).filter(e=>e.childElementCount<=3&&(e.innerText||'').trim().startsWith(${JSON.stringify(text)})).sort((a,b)=>a.innerText.length-b.innerText.length)[0]`);
const clickJs = (expr) => `(()=>{const e=${expr};if(e)e.click();return !!e})()`;
const click = async (page, x, y) => {
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
};
/** Pointer glides through a list of rects: p ∈ 0..n-1 (fractional), y corrected for the current scroll. */
const glide = (rects, p, scroll, dy = 0) => {
  const a = rects[Math.max(0, Math.floor(p))], b = rects[Math.min(rects.length - 1, Math.ceil(p))], f = p - Math.floor(p);
  return { x: lerp(a.x, b.x, f), y: lerp(a.top, b.top, f) - scroll + (a.h ?? 0) / 2 + dy };
};

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
  // Coin page (mock), "The loop" panel: pointer walks the four cells.
  loop: {
    site: MOCK, url: "/c/inbox-zero",
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
  // Coin page (mock), supply kiln: hover the top layers so the burn tooltip appears.
  kiln: {
    site: MOCK, url: "/c/inbox-zero",
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
  // Coin page (mock), fee transparency table (right column, below the stats card).
  fees: {
    site: MOCK, url: "/c/inbox-zero",
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

  /* ── pyre-venues (staging; see script-venues.mjs) ── */

  // Home feed (prod): every card carries "Robinhood Chain · pons v2"; pointer sweeps the top row.
  "v-home": {
    url: "/",
    seconds: 5,
    async plan(page) {
      const feed = (await page.evaluate(centerJs('[aria-label="Ranked feed"]'))) ?? { top: 480 };
      const targetScroll = Math.max(0, Math.round(feed.top - 110));
      const cards = [];
      for (let i = 0; i < 3; i++) cards.push((await page.evaluate(centerJs('[aria-label="Ranked feed"] article, [aria-label="Ranked feed"] a[aria-label]', i))) ?? { x: 430 + i * 355, y: 640, top: 600, h: 180 });
      const scroll = (u) => Math.round(lerp(0, targetScroll, easeInOut(Math.min(1, u / 0.5))));
      return {
        scroll,
        mouse: (u) => {
          const p = path([{ at: 0, i: -1 }, { at: 0.28, i: -1 }, { at: 0.42, i: 0 }, { at: 0.58, i: 0 }, { at: 0.7, i: 1 }, { at: 0.84, i: 1 }, { at: 1, i: 2 }])(u).i;
          if (p < 0) return { x: 1700, y: 1000 };
          return glide(cards, p, scroll(u), 10);
        },
      };
    },
  },
  // /launch signed in: the venue picker. Pointer rests on the Robinhood card, moves to Solana · pump.fun and clicks it.
  "v-picker": {
    site: STAGING, url: "/launch", session: true, venues: "production",
    seconds: 7,
    async plan(page) {
      const radios = [];
      for (let i = 0; i < 2; i++) radios.push((await page.evaluate(centerJs('[role=radiogroup][aria-label="Launch venue"] [role=radio]', i))) ?? { x: 700 + i * 380, top: 330, h: 120 });
      const pick = (await page.evaluate(centerJs('[role=radiogroup][aria-label="Launch venue"]'))) ?? { top: 300, h: 130 };
      const s = Math.max(0, Math.round(pick.top - 380));
      const scroll = () => s;
      const at = (i) => ({ x: radios[i].x + 30, y: radios[i].top - s + radios[i].h * 0.55 });
      return {
        scroll,
        mouse: path([{ at: 0, x: 1500, y: 980 }, { at: 0.22, ...at(0) }, { at: 0.42, ...at(0) }, { at: 0.56, ...at(1) }, { at: 0.8, ...at(1) }, { at: 1, x: at(1).x + 40, y: at(1).y + 36 }]),
        actions: [{ u: 0.6, run: () => click(page, at(1).x, at(1).y) }],
      };
    },
  },
  // /c/devnet-lens signed in: the Solana · pump.fun chip → "View on pump.fun" → the SOL trade panel.
  "v-coin": {
    site: STAGING, url: "/c/devnet-lens", session: true,
    seconds: 8,
    async plan(page) {
      const chip = (await page.evaluate(textJs("Solana · pump.fun"))) ?? { x: 715, top: 137, h: 22 };
      const view = (await page.evaluate(rectJs(`Array.from(document.querySelectorAll('main a[href*="pump.fun"]')).find(a=>/view on/i.test(a.textContent))`))) ?? { x: 550, top: 188, h: 20 };
      const buy = (await page.evaluate(rectJs(`Array.from(document.querySelectorAll('[aria-label="Trade"] button')).find(b=>/^(Buy \\$|Sign in to trade)/.test(b.textContent.trim()))`))) ?? { x: 1478, top: 690, h: 48 };
      const panel = (await page.evaluate(centerJs('[aria-label="Trade"]'))) ?? { x: 1478, top: 369, h: 440 };
      const scroll = (u) => Math.round(lerp(0, 70, easeInOut(Math.min(1, Math.max(0, (u - 0.45) / 0.45)))));
      const stops = [chip, chip, view, view, { x: panel.x, top: panel.top + 120, h: 0 }, buy];
      return {
        scroll,
        mouse: (u) => {
          const p = path([{ at: 0, i: -1 }, { at: 0.08, i: -1 }, { at: 0.2, i: 0 }, { at: 0.36, i: 1 }, { at: 0.46, i: 2 }, { at: 0.6, i: 3 }, { at: 0.74, i: 4 }, { at: 0.9, i: 5 }, { at: 1, i: 5 }])(u).i;
          if (p < 0) return { x: 1700, y: 1000 };
          return glide(stops, p, scroll(u));
        },
      };
    },
  },
  // Burns tab on the devnet coin page: one real burn; pointer rides swap → burn → attest.
  "v-burns": {
    site: STAGING, url: "/c/devnet-lens", session: true,
    seconds: 8,
    async plan(page) {
      await page.evaluate(clickJs(`Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent.trim()==='Burns')`));
      await sleep(1500);
      const tabs = (await page.evaluate(centerJs('[aria-label="Coin details"]'))) ?? { top: 1045 };
      const table = (await page.evaluate(centerJs('[aria-label="Coin details"] table'))) ?? { top: tabs.top + 250 };
      const links = [];
      for (let i = 0; i < 3; i++) links.push((await page.evaluate(centerJs('[aria-label="Coin details"] table tbody a', i))) ?? { x: 900 + i * 150, top: table.top + 40, h: 20 });
      const s = Math.max(0, Math.round(tabs.top - 230));
      const scroll = () => s;
      return {
        scroll,
        mouse: (u) => {
          const p = path([{ at: 0, i: -1 }, { at: 0.18, i: -1 }, { at: 0.3, i: 0 }, { at: 0.42, i: 0 }, { at: 0.52, i: 1 }, { at: 0.64, i: 1 }, { at: 0.74, i: 2 }, { at: 1, i: 2 }])(u).i;
          if (p < 0) return { x: 1700, y: 1000 };
          return glide(links, p, s);
        },
      };
    },
  },
  // /me signed in: the two custodial addresses, then "Deposit SOL" opens the tray.
  "v-me": {
    site: STAGING, url: "/me", session: true,
    seconds: 5,
    async plan(page) {
      const rh = (await page.evaluate(textJs("CUSTODIAL · ROBINHOOD"))) ?? { x: 800, top: 105, h: 20 };
      const sol = (await page.evaluate(textJs("CUSTODIAL · SOLANA"))) ?? { x: 605, top: 130, h: 20 };
      const dep = (await page.evaluate(rectJs(`Array.from(document.querySelectorAll('[aria-label="Balances"] button')).find(b=>b.textContent.trim()==='Deposit SOL')`))) ?? { x: 873, top: 408, h: 30 };
      const stops = [rh, sol, dep, dep];
      return {
        scroll: () => 0,
        mouse: (u) => {
          const p = path([{ at: 0, i: -1 }, { at: 0.08, i: -1 }, { at: 0.2, i: 0 }, { at: 0.3, i: 0 }, { at: 0.4, i: 1 }, { at: 0.48, i: 1 }, { at: 0.58, i: 2 }, { at: 1, i: 3 }])(u).i;
          if (p < 0) return { x: 1700, y: 1000 };
          return glide(stops, p, 0);
        },
        actions: [{ u: 0.6, run: () => click(page, dep.x, dep.top + dep.h / 2) }],
      };
    },
  },
  // /pyre: the "one coin, one chain" note, held still for the inset in the PYRE card scene.
  "v-pyrecard": {
    site: STAGING, url: "/pyre",
    seconds: 2.5,
    async plan(page) {
      const card = (await page.evaluate(rectJs(`Array.from(document.querySelectorAll('main *')).filter(e=>e.childElementCount<=3&&/^one coin, one chain/i.test((e.innerText||'').trim())).sort((a,b)=>a.innerText.length-b.innerText.length)[0]?.parentElement`))) ?? { top: 525, h: 105 };
      const s = Math.max(0, Math.round(card.top + card.h / 2 - 540));
      return { scroll: () => s, mouse: () => ({ x: 1900, y: 1070 }) };
    },
  },
};

/** Rewrite /v1/venues on the way in so the Solana stake reads as production (see SOL_STAKE_LAMPORTS). */
async function interceptVenues(page) {
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/v1/venues*", requestStage: "Response" }] });
  page.on("Fetch.requestPaused", async ({ requestId, responseStatusCode }) => {
    try {
      if (!responseStatusCode || responseStatusCode >= 300) return await page.send("Fetch.continueRequest", { requestId });
      const { body, base64Encoded } = await page.send("Fetch.getResponseBody", { requestId });
      const dto = JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body);
      for (const v of dto.venues ?? []) if (v.chain === "solana") v.stakeWei = SOL_STAKE_LAMPORTS;
      await page.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "access-control-allow-origin", value: "*" }], body: Buffer.from(JSON.stringify(dto)).toString("base64") });
    } catch (e) {
      console.log(`[capture] venues intercept: ${e.message}`);
      await page.send("Fetch.continueRequest", { requestId }).catch(() => {});
    }
  });
  return () => page.send("Fetch.disable");
}

export async function capture(names = Object.keys(SEGMENTS)) {
  const page = await launch({ width: W, height: H });
  try {
    for (const name of names) {
      const seg = SEGMENTS[name];
      if (!seg) throw new Error(`unknown segment ${name}`);
      const site = seg.site ?? SITE;
      const dir = join(OUT, name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      if (seg.session) {
        if (!existsSync(SESSION_FILE)) throw new Error(`${name} needs a signed session token at ${SESSION_FILE} (PYRE_STAGING_SESSION_FILE)`);
        await page.goto(site + "/", 500);
        await page.evaluate(`localStorage.setItem("pyre_session", ${JSON.stringify(readFileSync(SESSION_FILE, "utf8").trim())}); 1`);
      }
      const release = seg.venues === "production" ? await interceptVenues(page) : null;
      await page.goto(site + seg.url, 6500);
      await page.evaluate(`document.documentElement.style.scrollBehavior='auto';document.body.style.cursor='none';1`);
      const plan = await seg.plan(page);
      const actions = (plan.actions ?? []).map((a) => ({ ...a, done: false }));
      const n = Math.round(seg.seconds * FPS);
      const t0 = Date.now();
      for (let i = 0; i < n; i++) {
        const u = n === 1 ? 0 : i / (n - 1);
        const y = plan.scroll(u);
        const m = plan.mouse(u);
        await page.evaluate(`window.scrollTo(0, ${y}); ${y}`);
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(m.x), y: Math.round(m.y) });
        for (const a of actions) if (!a.done && u >= a.u) { a.done = true; await a.run(); }
        // let the page apply hover styles / scroll-linked layout before the grab
        await page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
        writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.png`), await page.screenshot());
      }
      await release?.();
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ frames: n, fps: FPS, width: W, height: H, site, url: seg.url, seconds: seg.seconds }));
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
