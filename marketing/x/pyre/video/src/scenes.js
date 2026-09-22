/* pyre-launch — deterministic scene engine.
 * window.__seek(t) lays out the frame for absolute time t (seconds) and resolves
 * once fonts and capture frames are decoded. `?t=` in the URL seeks on load so a
 * single frame can be eyeballed in a browser. Everything is a pure function of t.
 */
(() => {
  const TL = window.TIMELINE;
  const FPS = TL.fps;
  const url = new URL(location.href);
  const sq = url.searchParams.get("sq") === "1";
  const W = sq ? 1080 : 1920, H = 1080;
  const stage = document.getElementById("stage");
  stage.style.setProperty("--W", W + "px");
  stage.style.setProperty("--H", H + "px");
  if (sq) stage.classList.add("sq");

  /* ── easing (brand: reveal ≈ quart, scene ≈ expo, heat ≈ quint) ── */
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const quart = (x) => 1 - Math.pow(1 - x, 4);
  const expo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
  const quint = (x) => 1 - Math.pow(1 - x, 5);
  const inout = (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2);
  const lin = (x) => x;
  /** progress 0..1 over [a, a+d] with easing e */
  const seg = (t, a, d, e = quart) => e(clamp01((t - a) / d));
  const lerp = (a, b, x) => a + (b - a) * x;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fadeUp = (el, p, dy = 26) => {
    el.style.opacity = p;
    el.style.transform = `translateY(${(1 - p) * dy}px)`;
  };
  const show = (el, p) => { el.style.opacity = p; };
  const typed = (el, text, p) => { el.textContent = text.slice(0, Math.round(p * text.length)); };
  const caret = (el, t, on = true) => { el.style.opacity = on && Math.floor(t * 2.4) % 2 === 0 ? 1 : 0; };
  const heat = (scene, h, o = 1) => {
    const el = $(".heat", scene);
    el.style.height = `${h * 100}%`;
    el.style.opacity = o;
  };
  /** wrap words of every text node under el in .w > span for mask reveals (once) */
  const wrapWords = (el) => {
    if (el.dataset.wrapped) return;
    el.dataset.wrapped = "1";
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach((tok) => {
            if (!tok) return;
            if (/^\s+$/.test(tok)) { frag.appendChild(document.createTextNode(" ")); return; }
            const w = document.createElement("span"); w.className = "w";
            const s = document.createElement("span"); s.textContent = tok; w.appendChild(s);
            frag.appendChild(w);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === 1 && child.tagName !== "SPAN") walk(child);
        else if (child.nodeType === 1 && child.tagName === "SPAN" && !child.classList.contains("w")) walk(child);
      }
    };
    walk(el);
  };
  const revealWords = (el, t, a, d = 0.7, stagger = 0.07) => {
    wrapWords(el);
    $$(".w > span", el).forEach((s, i) => {
      const p = seg(t, a + i * stagger, d, expo);
      s.style.transform = `translateY(${(1 - p) * 110}%)`;
    });
  };
  const riseIn = (el, t, a, d = 0.8) => {
    const p = seg(t, a, d, expo);
    el.firstElementChild.style.transform = `translateY(${(1 - p) * 110}%)`;
  };

  /* ── capture scenes ── */
  const capMeta = {};
  const capSrc = (name, i) => `../build/cap/${name}/f${String(i).padStart(4, "0")}.png`;
  const frameOf = (name, t, offset = 0) => {
    const n = capMeta[name]?.frames ?? 1;
    return Math.min(n - 1, Math.max(0, Math.floor(t * FPS) + offset));
  };
  /** cover-fit a 1920×1080 capture into the stage: zoom drifts z0→z1, the focal point (fx,fy) is kept near stage centre */
  const placeCap = (img, t, D, [fx, fy], [z0, z1], sqzoom = 0.86) => {
    const p = seg(t, 0, D, lin);
    const scale = Math.max(H / 1080, Math.max(W / 1920, H / 1080) * lerp(z0, z1, p) * (sq ? sqzoom : 1));
    const iw = 1920 * scale, ih = 1080 * scale;
    const maxX = (iw - W) / 2, maxY = (ih - H) / 2;
    const tx = Math.max(-maxX, Math.min(maxX, (0.5 - fx) * iw));
    const ty = Math.max(-maxY, Math.min(maxY, (0.5 - fy) * ih + lerp(10, -10, p)));
    img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${scale})`;
  };

  /* ── scenes ── */
  const S = {};

  S.open = {
    el: $("#s-open"), kind: "wipe",
    update(t) {
      const el = this.el;
      heat(el, lerp(0, 0.36, seg(t, 0.2, 1.6, quint)), seg(t, 0.2, 1.2, quart) * 0.9);
      const mark = $(".mark", el);
      const mp = seg(t, 0.5, 1.0, expo);
      mark.style.opacity = mp;
      mark.style.transform = `translate(-50%, ${sq ? -240 : -285}px) scale(${lerp(0.9, 1, mp)})`;
      revealWords($(".l1", el), t, 0.75, 0.8, 0.09);
      revealWords($(".l2", el), t, 2.25, 0.8, 0.09);
      const sp = seg(t, 3.3, 0.7);
      $(".sub", el).style.opacity = sp;
      $(".sub", el).style.transform = `translate(-50%, ${(sq ? 200 : 250) + (1 - sp) * 12}px)`;
    },
  };

  const PROMPT = "grade my landing page and tell me what to fix";
  S["launch-mg"] = {
    el: $("#s-launch"), kind: "wipe",
    update(t, D) {
      const el = this.el;
      fadeUp($(".label", el), seg(t, 0.2, 0.6), 10);
      const prompt = $(".prompt", el);
      fadeUp(prompt, seg(t, 0.3, 0.7, expo), 30);
      typed($(".typed", prompt), PROMPT, seg(t, 0.7, 1.9, lin));
      caret($(".caret", prompt), t, t < 3.2);
      const spec = $(".spec", el);
      const sp = seg(t, 3.0, 0.9, expo);
      spec.style.opacity = sp;
      spec.style.transform = `translateY(${(1 - sp) * 40}px)`;
      spec.style.clipPath = `inset(0 0 ${(1 - sp) * 100}% 0)`;
      $$(".row", spec).forEach((r, i) => fadeUp(r, seg(t, 3.4 + i * 0.18, 0.5), 14));
      const ap = seg(t, 4.5, 0.4);
      const approve = $(".approve", spec);
      approve.style.opacity = ap;
      approve.style.background = `rgba(122,102,245,${0.28 * seg(t, 4.7, 0.4)})`;
      fadeUp($(".stake", el), seg(t, 5.1, 0.6, expo), 18);
      fadeUp($(".wallet", el), seg(t, 5.35, 0.6, expo), 18);
      const ll = $(".launchline", el);
      fadeUp(ll, seg(t, 6.0, 0.7, expo), 22);
      revealWords(ll, t, 6.0, 0.7, 0.06);
      fadeUp($(".addr", el), seg(t, 6.6, 0.6), 10);
      heat(el, lerp(0.08, 0.34, seg(t, 6.0, 1.4, quint)), lerp(0.35, 0.9, seg(t, 6.0, 1.2)));
    },
  };

  S["fees-mg"] = {
    el: $("#s-fees"), kind: "wipe",
    update(t) {
      const el = this.el;
      fadeUp($(".label", el), seg(t, 0.2, 0.6), 10);
      revealWords($(".h2", el), t, 0.35, 0.7, 0.07);
      const rows = [$(".r1", el), $(".r2", el), $(".r3", el), $(".r4", el), $(".r5", el)];
      const starts = [1.2, 2.6, 4.9, 6.0, 7.1];
      const widths = [1, 0.7, 0.7 * 0.6, 0.7 * 0.25, 0.7 * 0.15];
      rows.forEach((r, i) => {
        const a = starts[i];
        fadeUp(r, seg(t, a, 0.5, expo), 16);
        $(".bar > i", r).style.width = `${widths[i] * 100 * seg(t, a + 0.15, 0.9, quart)}%`;
        $(".v", r).style.opacity = seg(t, a + 0.5, 0.4);
      });
      // rows 3-5 sit inside the 70% share: nudge them to start where the 70% bar starts
      fadeUp($(".foot", el), seg(t, 8.0, 0.6), 8);
      heat(el, 0.18, lerp(0.25, 0.6, seg(t, 4.9, 2)));
    },
  };

  const LOG = [
    [0.5, "00:00.0", "INFO", "budget reached $50.00 · queued build · pagegrade"],
    [1.0, "00:00.4", "INFO", "sandbox e2b i7ms0kqb · template pyre-starter · 2 vcpu · 4 gb"],
    [1.5, "00:01.1", "INFO", "claude agent sdk · job token j_8f21c · cap $50.00"],
    [2.2, "00:02.6", "THINK", "reading spec: score a landing page, list fixes, full report for holders"],
    [3.0, "00:04.0", "EDIT", "src/App.tsx · src/lib/score.ts · src/lib/fixes.ts  +212 −14"],
    [3.9, "00:05.3", "RUN", "npm run build ✓ 4.1s"],
    [4.5, "00:06.0", "RUN", "playwright smoke · 3 passed · 0 failed"],
    [5.0, "00:06.6", "RUN", "screenshots ×3 · 1440 · 390"],
    [5.6, "00:07.4", "RUN", "lighthouse perf 97 · a11y 100 · bp 96 · seo 100"],
    [6.4, "00:08.1", "REVIEW", "approve · diff matches the spec · no auth or wallet surfaces touched · nothing asks for money"],
    [7.1, "00:08.4", "DEPLOY", "pagegrade.pyre.fun · v1 · spent $18.42"],
  ];
  const GATE_AT = { build: 3.9, smoke: 4.5, shots: 5.0, lh: 5.6, review: 6.4, deploy: 7.1 };
  S["agent-mg"] = {
    el: $("#s-agent"), kind: "wipe",
    init() {
      const lines = $(".lines", this.el);
      lines.innerHTML = LOG.map(([, ts, lv]) => `<div class="ln"><span class="ts">${ts}</span><span class="lv ${lv}">${lv}</span><span class="tx"></span></div>`).join("");
    },
    update(t) {
      const el = this.el;
      const con = $(".console", el), gates = $(".gates", el);
      fadeUp(con, seg(t, 0.15, 0.7, expo), 26);
      fadeUp(gates, seg(t, 0.35, 0.7, expo), 26);
      $$(".ln", el).forEach((ln, i) => {
        const [at, , , text] = LOG[i];
        const on = t >= at;
        ln.classList.toggle("on", on);
        if (on) typed($(".tx", ln), text, seg(t, at, 0.28, lin));
      });
      $$(".g", gates).forEach((g) => g.classList.toggle("on", t >= GATE_AT[g.dataset.gate] + 0.25));
      const dp = seg(t, 7.2, 1.2, quint);
      heat(el, lerp(0.06, 0.3, dp), lerp(0.25, 0.9, dp));
    },
  };

  S["app-mg"] = {
    el: $("#s-app"), kind: "wipe",
    update(t) {
      const el = this.el;
      const br = $(".browser", el);
      const bp = seg(t, 0.15, 0.8, expo);
      br.style.opacity = bp;
      br.style.transform = `translate(-50%, ${(sq ? -57 : -50) + (1 - bp) * 3}%) scale(${lerp(0.97, 1, bp)})`;
      typed($(".u", el), "https://pagegrade.pyre.fun", seg(t, 0.5, 0.9, lin));
      caret($(".caret", $(".bar-url", el)), t, t < 1.6);
      const btn = $(".btn", el);
      const press = seg(t, 1.9, 0.18, inout) * (1 - seg(t, 2.1, 0.2, inout));
      btn.style.transform = `scale(${1 - 0.05 * press})`;
      const co = $(".tier", el);
      const cp = seg(t, 2.15, 0.7, expo);
      co.style.opacity = cp;
      co.style.transform = `translateY(${(1 - cp) * 40}px)`;
      const marks = [[".s1", 2.9], [".s2", 3.4], [".s3", 3.9]];
      for (const [sel, at] of marks) {
        const s = $(sel, co);
        const done = t >= at;
        s.textContent = done ? "✓" : "…";
        s.classList.toggle("ok", done);
      }
      const paid = t >= 4.15;
      btn.classList.toggle("paid", paid);
      btn.textContent = paid ? "unlocked · holder" : "grade it · free";
      fadeUp($(".under", el), seg(t, 1.0, 0.7), 12);
      $(".under", el).style.transform = `translate(-50%, ${(1 - seg(t, 1.0, 0.7)) * 12}px)`;
      heat(el, 0.16, lerp(0.3, 0.8, seg(t, 4.1, 1)));
    },
  };

  S["share-mg"] = {
    el: $("#s-share"), kind: "wipe",
    update(t) {
      const el = this.el;
      fadeUp($(".label", el), seg(t, 0.2, 0.5), 10);
      revealWords($(".h2", el), t, 0.3, 0.7, 0.06);
      const p = seg(t, 1.0, 1.4, quart);
      const a = $(".split .a", el), b = $(".split .b", el), c = $(".split .c", el);
      const wa = Math.min(25, p * 100), wb = Math.max(0, Math.min(75, p * 100 - 25)), wc = 0;
      a.style.width = `${wa}%`;
      b.style.left = `${wa}%`; b.style.width = `${wb}%`;
      c.style.left = `${wa + wb}%`; c.style.width = `${wc}%`;
      $$(".legend > div", el).forEach((d, i) => fadeUp(d, seg(t, 1.5 + i * 0.35, 0.5, expo), 14));
      fadeUp($(".foot", el), seg(t, 2.5, 0.5), 8);
      heat(el, 0.2, lerp(0.3, 0.7, seg(t, 1, 1.5)));
    },
  };

  const LAYERS = 20;
  const PREFIX = "0x5059524501";
  const HASH = "6f8ff5278cfc64a47c0f72494e121e477ba38f52bf7cf8d096c34cf1d7b1135d"; // sha256 of two example fee entry ids
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  S["burn-mg"] = {
    el: $("#s-burn"), kind: "wipe",
    init() {
      const svg = $("svg", this.el);
      const w = 240, h = 18, cx = 160, pad = 10;
      const top0 = pad + (LAYERS - 1) * h + 20;
      let out = "";
      for (let k = 0; k < LAYERS; k++) {
        const top = top0 - k * h;
        const T = `${cx},${top} ${cx + w / 2},${top + w / 4} ${cx},${top + w / 2} ${cx - w / 2},${top + w / 4}`;
        const L = `${cx - w / 2},${top + w / 4} ${cx},${top + w / 2} ${cx},${top + w / 2 + h} ${cx - w / 2},${top + w / 4 + h}`;
        const R = `${cx},${top + w / 2} ${cx + w / 2},${top + w / 4} ${cx + w / 2},${top + w / 4 + h} ${cx},${top + w / 2 + h}`;
        out += `<g class="layer" data-k="${k}"><polygon points="${L}"/><polygon points="${R}"/><polygon points="${T}"/></g>`;
      }
      svg.innerHTML = out;
    },
    update(t) {
      const el = this.el;
      fadeUp($(".label", el), seg(t, 0.2, 0.5), 10);
      $$(".layer", el).forEach((g, k) => {
        const p = seg(t, 0.2 + k * 0.045, 0.6, expo);
        g.style.opacity = p;
        g.style.transform = `translateY(${(1 - p) * 18}px)`;
        const burnAt = k === LAYERS - 1 ? 2.6 : k === LAYERS - 2 ? 2.85 : Infinity;
        g.classList.toggle("hot", t >= burnAt && t < burnAt + 0.5);
        g.classList.toggle("hollow", t >= burnAt + 0.5);
      });
      const sup = $(".supply", el);
      fadeUp(sup, seg(t, 0.6, 0.6), 12);
      const burned = seg(t, 2.6, 1.3, quart) * 0.10;
      $(".n", sup).textContent = fmt(1e9 * (1 - burned));
      $(".n", sup).style.color = t >= 2.6 && t < 4.2 ? "var(--burn)" : "var(--ink)";
      fadeUp($(".s1", el), seg(t, 1.1, 0.5, expo), 12);
      fadeUp($(".s2", el), seg(t, 2.45, 0.35, expo), 12);
      fadeUp($(".s3", el), seg(t, 3.7, 0.5, expo), 12);
      const att = $(".att", el);
      fadeUp(att, seg(t, 3.9, 0.6, expo), 20);
      typed($(".bytes .p", att), PREFIX, seg(t, 4.3, 0.45, lin));
      typed($(".bytes .h", att), HASH, seg(t, 4.8, 1.7, lin));
      caret($(".bytes .caret", att), t, t >= 4.3 && t < 6.6);
      // thump: the floor flares white-hot and cools
      const flare = seg(t, 2.6, 0.12, quart) * (1 - seg(t, 2.72, 1.6, quart));
      heat(el, lerp(0.16, 0.5, flare), lerp(0.35, 1, flare));
    },
  };

  S["dormant-mg"] = {
    el: $("#s-dormant"), kind: "wipe",
    update(t) {
      const el = this.el;
      fadeUp($(".top", el), seg(t, 0.2, 0.5), 10);
      $(".top", el).style.transform = `translate(-50%, ${-330 + (1 - seg(t, 0.2, 0.5)) * 10}px)`;
      const ash = seg(t, 0.4, 1.3, quart) * (1 - seg(t, 2.6, 1.1, quint));
      $(".ash", el).style.opacity = ash;
      $(".tile img", el).style.filter = `saturate(${1 - 0.7 * ash}) brightness(${1 - 0.25 * ash})`;
      const st = $(".state .st", el);
      const dormant = t < 2.55;
      st.textContent = dormant ? "dormant · ash" : "relit · heating";
      st.style.color = dormant ? "var(--ink3)" : "var(--accent)";
      const sp = dormant ? seg(t, 0.9, 0.6) : seg(t, 2.55, 0.5);
      st.style.opacity = sp;
      const fee = $(".fee", el);
      const fp = seg(t, 2.2, 0.5, expo);
      fee.style.opacity = fp;
      fee.style.transform = `translate(-50%, ${(sq ? 250 : 290) + (1 - fp) * 16}px)`;
      $(".budget", el).textContent = t < 2.55 ? "$0.00" : `$${(4.12 * seg(t, 2.55, 0.8)).toFixed(2)}`;
      const relit = seg(t, 2.6, 1.3, quint);
      heat(el, lerp(0.0, 0.36, relit), relit * 0.95);
    },
  };

  S.proof = {
    el: $("#s-proof"), kind: "wipe",
    update(t) {
      const el = this.el;
      fadeUp($(".label", el), seg(t, 0.2, 0.5), 10);
      $$(".cell", el).forEach((c, i) => {
        riseIn($(".n", c), t, 0.35 + i * 0.22, 0.8);
        fadeUp($(".t", c), seg(t, 0.75 + i * 0.22, 0.5), 8);
        fadeUp($(".d", c), seg(t, 0.9 + i * 0.22, 0.5), 8);
      });
      $$(".lines > div", el).forEach((d, i) => fadeUp(d, seg(t, 2.0 + i * 0.35, 0.5, expo), 8));
      heat(el, 0.16, lerp(0.3, 0.6, seg(t, 2, 2)));
    },
  };

  S.close = {
    el: $("#s-close"), kind: "wipe",
    update(t) {
      const el = this.el;
      riseIn($(".lockup", el), t, 0.3, 0.9);
      fadeUp($(".line", el), seg(t, 1.0, 0.6), 10);
      $(".line", el).style.transform = `translate(-50%, ${150 + (1 - seg(t, 1.0, 0.6)) * 10}px)`;
      fadeUp($(".soon", el), seg(t, 1.8, 0.6), 6);
      $(".soon", el).style.transform = `translate(-50%, 215px)`;
      heat(el, lerp(0.1, 0.3, seg(t, 0.3, 2.0, quint)), lerp(0.4, 0.95, seg(t, 0.3, 1.5)));
    },
  };

  for (const id of ["launch-cap", "fees-cap", "share-cap", "burn-cap"]) {
    const el = $(`#s-${id}`);
    S[id] = {
      el, kind: "mask",
      update(t, D) {
        const name = el.dataset.cap, focal = ((sq && el.dataset.sqfocal) || el.dataset.focal).split(",").map(Number), zoom = el.dataset.zoom.split(",").map(Number), offset = +(el.dataset.offset ?? 0);
        const img = $(".cap", el);
        const src = capSrc(name, frameOf(name, t, offset));
        if (img.getAttribute("src") !== src) img.setAttribute("src", src);
        placeCap(img, t, D, focal, zoom, +(el.dataset.sqzoom ?? 0.86));
        const cap = $(".caption", el);
        fadeUp(cap, seg(t, 0.5, 0.6, expo), 14);
        const pip = $(".pip", el);
        if (pip) {
          const pname = el.dataset.pip;
          const [fx, fy] = el.dataset.pipfocal.split(",").map(Number);
          const pimg = $("img", pip);
          const psrc = capSrc(pname, frameOf(pname, t, 0));
          if (pimg.getAttribute("src") !== psrc) pimg.setAttribute("src", psrc);
          const pp = seg(t, 0.9, 0.8, expo);
          pip.style.opacity = pp;
          pip.style.transform = `translateY(${(1 - pp) * 30}px)`;
          const pw = pip.clientWidth, ph = pip.clientHeight, z = sq ? 0.8 : 0.95;
          pimg.style.transform = `translate(${pw / 2 - fx * 1920 * z}px, ${ph / 2 - fy * 1080 * z}px) scale(${z})`;
          pimg.style.transformOrigin = "0 0";
        }
      },
    };
  }

  for (const s of Object.values(S)) s.init?.();

  /* ── the clock ── */
  const shots = TL.shots;
  const WIPE = 0.7;
  const wipe = document.getElementById("wipe");
  const pendingImgs = () => $$(".scene.on img").filter((i) => !i.complete || i.naturalWidth === 0);

  async function seek(t) {
    let i = shots.findIndex((s) => t < s.start + s.dur);
    if (i < 0) i = shots.length - 1;
    const cur = shots[i], prev = i > 0 ? shots[i - 1] : null;
    const curS = S[cur.id], prevS = prev ? S[prev.id] : null;
    const trans = prev && t < cur.start + WIPE;
    for (const s of Object.values(S)) {
      const on = s === curS || (trans && s === prevS);
      s.el.classList.toggle("on", on);
      if (!on) { s.el.style.clipPath = ""; s.el.style.transform = ""; s.el.style.filter = ""; s.el.style.zIndex = ""; }
    }
    curS.el.style.zIndex = 2;
    wipe.classList.toggle("on", false);
    if (trans) {
      prevS.el.style.zIndex = 1;
      const p = inout(clamp01((t - cur.start) / WIPE));
      if (curS.kind === "mask") {
        const k = 1 - p;
        curS.el.style.clipPath = `inset(${k * 44}% ${k * 30}% ${k * 44}% ${k * 30}% round ${k * 48}px)`;
      } else {
        curS.el.style.clipPath = `inset(${(1 - p) * 100}% 0 0 0)`;
        wipe.classList.toggle("on", true);
        wipe.style.top = `${(1 - p) * H - 220}px`;
        wipe.style.opacity = 1 - seg(p, 0.55, 0.45, quart);
      }
      prevS.el.style.transform = `translateY(${-36 * p}px)`;
      prevS.el.style.filter = `brightness(${1 - 0.4 * p})`;
      prevS.update(prev.dur + (t - cur.start), prev.dur);
    } else {
      curS.el.style.clipPath = "";
    }
    curS.update(t - cur.start, cur.dur);
    await document.fonts.ready;
    const imgs = pendingImgs();
    await Promise.all(imgs.map((im) => im.decode().catch(() => {})));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { shot: cur.id, local: +(t - cur.start).toFixed(3) };
  }

  window.__seek = seek;
  window.__setCapMeta = (m) => Object.assign(capMeta, m);
  window.__ready = (async () => {
    await document.fonts.load('400 40px "Instrument Serif"');
    await document.fonts.load('italic 400 40px "Instrument Serif"');
    await document.fonts.load('400 20px Geist');
    await document.fonts.load('400 20px "Geist Mono"');
    const t0 = url.searchParams.get("t");
    if (t0 !== null) {
      // browser preview: guess frame counts from the capture meta if provided, else assume plenty
      for (const n of ["launch", "home", "loop", "kiln", "fees", "burns"]) capMeta[n] ??= { frames: 100 };
      await seek(+t0);
    }
    return true;
  })();
})();
