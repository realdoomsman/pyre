/* media films — deterministic stage. render.mjs loads stage.html, calls
 * window.__init({ tl, capMeta, sq }) with a film's timeline, then window.__seek(t)
 * per frame. Everything drawn is a pure function of t. */
(() => {
  const stage = document.getElementById("stage");
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* easing (brand: reveal ≈ quart, scene ≈ expo, heat ≈ quint) */
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const quart = (x) => 1 - Math.pow(1 - x, 4);
  const expo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
  const quint = (x) => 1 - Math.pow(1 - x, 5);
  const inout = (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2);
  const lin = (x) => x;
  const seg = (t, a, d, e = quart) => e(clamp01((t - a) / d));
  const lerp = (a, b, x) => a + (b - a) * x;

  const fadeUp = (el, p, dy = 26) => { el.style.opacity = p; el.style.transform = `translateY(${(1 - p) * dy}px)`; };
  const heat = (scene, h, o = 1) => { const el = $(".heat", scene); if (!el) return; el.style.height = `${h * 100}%`; el.style.opacity = o; };
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
        } else if (child.nodeType === 1 && !child.classList.contains("w")) walk(child);
      }
    };
    walk(el);
  };
  const revealWords = (el, t, a, d = 0.7, stagger = 0.07) => {
    wrapWords(el);
    $$(".w > span", el).forEach((s, i) => { s.style.transform = `translateY(${(1 - seg(t, a + i * stagger, d, expo)) * 110}%)`; });
  };
  const riseIn = (el, t, a, d = 0.8) => { el.firstElementChild.style.transform = `translateY(${(1 - seg(t, a, d, expo)) * 110}%)`; };

  let TL, FPS, sq, W, H;
  const capMeta = {};
  const capSrc = (name, i) => `../build/cap/${name}/f${String(i).padStart(4, "0")}.png`;
  const frameOf = (name, t) => Math.min((capMeta[name]?.frames ?? 1) - 1, Math.max(0, Math.floor(t * FPS)));
  /** cover-fit a 1920×1080 capture: zoom drifts z0→z1 over the shot, focal point (fx,fy) kept near stage centre */
  const placeCap = (img, t, D, [fx, fy], [z0, z1]) => {
    const p = seg(t, 0, D, lin);
    const base = Math.max(W / 1920, H / 1080);
    const scale = base * lerp(z0, z1, p);
    const iw = 1920 * scale, ih = 1080 * scale;
    const maxX = (iw - W) / 2, maxY = (ih - H) / 2;
    const tx = Math.max(-maxX, Math.min(maxX, (0.5 - fx) * iw));
    const ty = Math.max(-maxY, Math.min(maxY, (0.5 - fy) * ih + lerp(8, -8, p)));
    img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${scale})`;
  };

  const S = {};
  const title = (el, { l1 = 0.7, l2 = 2.0, sub = 3.0, mark = true } = {}) => ({
    el, kind: "wipe",
    update(t) {
      heat(el, lerp(0, 0.36, seg(t, 0.2, 1.6, quint)), seg(t, 0.2, 1.2, quart) * 0.9);
      const m = $(".mark", el);
      if (m) { const mp = seg(t, 0.4, 1.0, expo); m.style.opacity = mark ? mp : 0; m.style.transform = `translate(-50%, ${sq ? -250 : -300}px) scale(${lerp(0.9, 1, mp)})`; }
      const a = $(".l1", el), b = $(".l2", el);
      if (a) revealWords(a, t, l1, 0.8, 0.09);
      if (b) revealWords(b, t, l2, 0.8, 0.09);
      const s = $(".sub", el);
      if (s) { const sp = seg(t, sub, 0.7); s.style.opacity = sp; s.style.transform = `translate(-50%, ${(sq ? 190 : 220) + (1 - sp) * 12}px)`; }
    },
  });
  const closer = (el) => ({
    el, kind: "wipe",
    update(t) {
      const line = $(".line", el);
      const lp = seg(t, 0.3, 0.7);
      line.style.opacity = lp;
      line.style.transform = `translate(-50%, ${120 + (1 - lp) * 12}px)`;
      revealWords(line, t, 0.3, 0.7, 0.06);
      riseIn($(".lockup", el), t, 1.2, 0.9);
      const f = $(".foot", el);
      const fp = seg(t, 2.0, 0.6);
      f.style.opacity = fp;
      f.style.transform = `translate(-50%, ${(sq ? 260 : 250) + (1 - fp) * 8}px)`;
      heat(el, lerp(0.1, 0.3, seg(t, 0.3, 2.0, quint)), lerp(0.4, 0.95, seg(t, 0.3, 1.5)));
    },
  });

  /* ── burn film: bytes ── */
  const bytesScene = () => {
    const el = $("#s-burn-bytes");
    const grid = $(".bytes", el);
    return {
      el, kind: "wipe",
      init() {
        const hash = TL.attest.hash.slice(2).match(/../g);
        const cells = ["50", "59", "52", "45", "01", ...hash];
        grid.innerHTML = cells.map((c, i) => `<div class="b ${i < 4 ? "p" : i === 4 ? "v" : ""}">${c}</div>`).join("");
      },
      update(t) {
        fadeUp($(".label", el), seg(t, 0.2, 0.5), 10);
        revealWords($(".h2", el), t, 0.35, 0.7, 0.06);
        const cells = $$(".b", grid);
        const n = cells.length;
        const shown = Math.floor(seg(t, 1.2, 3.6, lin) * n + 1e-6);
        cells.forEach((c, i) => {
          const p = i < shown ? seg(t, 1.2 + (i / n) * 3.6, 0.3, expo) : 0;
          c.style.opacity = p; c.style.transform = `translateY(${(1 - p) * 8}px)`;
          c.style.boxShadow = i === shown - 1 && t < 5 ? "0 0 0 1px rgba(157,140,255,.6)" : "none";
        });
        $$(".legend > div", el).forEach((d, i) => fadeUp(d, seg(t, [1.5, 2.1, 3.2][i], 0.5), 10));
        fadeUp($(".foot", el), seg(t, 5.0, 0.6), 8);
        heat(el, 0.14, lerp(0.25, 0.55, seg(t, 4.5, 1.5)));
      },
    };
  };

  /* ── burn film: hash ── */
  const hashScene = () => {
    const el = $("#s-burn-hash");
    return {
      el, kind: "wipe",
      init() {
        $(".idlist", el).innerHTML = TL.attest.ids.map((id) => `<div class="id">${id}</div>`).join("");
        $(".hash", el).innerHTML = `<span class="p">0x5059524501</span><span class="h"></span>`;
      },
      update(t) {
        revealWords($(".h2", el), t, 0.3, 0.7, 0.06);
        $$(".id", el).forEach((d, i) => fadeUp(d, seg(t, 0.9 + i * 0.25, 0.5), 8));
        $$(".steps .chip", el).forEach((c, i) => fadeUp(c, seg(t, 1.9 + i * 0.35, 0.45, expo), 10));
        const h = TL.attest.hash.slice(2);
        const p = seg(t, 3.0, 1.8, lin);
        $(".hash .h", el).textContent = h.slice(0, Math.round(p * h.length));
        fadeUp($(".match", el), seg(t, 5.1, 0.6, expo), 8);
        heat(el, 0.14, lerp(0.25, 0.55, seg(t, 4.8, 1.2)));
      },
    };
  };

  /* ── burn film: explorer ── */
  const explorerScene = () => {
    const el = $("#s-burn-explorer");
    return {
      el, kind: "wipe",
      init() { $(".hashv", el).textContent = TL.attest.hash.slice(2); },
      update(t) {
        const b = $("#tx-burn", el), a = $("#tx-attest", el);
        const bp = seg(t, 0.3, 0.8, expo), ap = seg(t, 2.3, 0.8, expo);
        b.style.opacity = bp; b.style.transform = `translateY(${(1 - bp) * 24}px)`;
        a.style.opacity = ap; a.style.transform = `translateY(${(1 - ap) * 24}px)`;
        $$(".r", b).forEach((r, i) => fadeUp(r, seg(t, 0.6 + i * 0.16, 0.45), 6));
        fadeUp($(".supply", b), seg(t, 1.6, 0.6, expo), 8);
        $$(".r", a).forEach((r, i) => fadeUp(r, seg(t, 2.6 + i * 0.16, 0.45), 6));
        const cap = $(".caption", el);
        if (cap) fadeUp(cap, seg(t, 0.4, 0.6, expo), 14);
        heat(el, 0.16, lerp(0.2, 0.5, seg(t, 1.6, 1.4)));
      },
    };
  };

  /* ── capture shots (built from the timeline) ── */
  const capScene = (shot) => {
    const el = document.createElement("section");
    el.className = "scene cap-scene";
    el.id = `s-${TL.film}-${shot.id}`;
    el.innerHTML = `<div class="capwrap"><img class="cap" alt=""></div><div class="capfade"></div>` +
      (shot.overlay ? `<div class="overlay serif">${shot.overlay}</div>` : "") +
      (shot.caption ? `<div class="caption"><span class="chip ${shot.caption.startsWith("live") ? "earn" : "warn"}"><span class="dot"></span>${shot.caption}</span></div>` : "");
    stage.insertBefore(el, $("#wipe"));
    const focal = (sq && shot.sqfocal) || shot.focal;
    return {
      el, kind: "mask",
      update(t, D) {
        const img = $(".cap", el);
        const src = capSrc(shot.cap, frameOf(shot.cap, t));
        if (img.getAttribute("src") !== src) img.setAttribute("src", src);
        placeCap(img, t, D, focal, shot.zoom);
        const cap = $(".caption", el);
        if (cap) fadeUp(cap, seg(t, 0.5, 0.6, expo), 14);
        const ov = $(".overlay", el);
        if (ov) { fadeUp(ov, seg(t, 0.55, 0.7, expo), 18); revealWords(ov, t, 0.55, 0.7, 0.05); }
      },
    };
  };

  /* ── the clock ── */
  const WIPE = 0.7;
  const wipe = document.getElementById("wipe");
  const pendingImgs = () => $$(".scene.on img").filter((i) => !i.complete || i.naturalWidth === 0);

  async function seek(t) {
    const shots = TL.shots;
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
    await Promise.all(pendingImgs().map((im) => im.decode().catch(() => {})));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { shot: cur.id, local: +(t - cur.start).toFixed(3) };
  }

  window.__init = async ({ tl, capMeta: meta, sq: square }) => {
    TL = tl; FPS = tl.fps; sq = !!square; W = sq ? 1080 : 1920; H = 1080;
    Object.assign(capMeta, meta);
    stage.style.setProperty("--W", W + "px");
    stage.style.setProperty("--H", H + "px");
    stage.classList.toggle("sq", sq);
    for (const s of tl.shots) {
      if (s.cap) { S[s.id] = capScene(s); continue; }
      const id = `${tl.film}/${s.id}`;
      if (s.id === "open") S[s.id] = title($(`#s-${tl.film}-open`));
      else if (s.id === "close") S[s.id] = closer($(`#s-${tl.film}-close`));
      else if (id === "burn/bytes") S[s.id] = bytesScene();
      else if (id === "burn/hash") S[s.id] = hashScene();
      else if (id === "burn/explorer") S[s.id] = explorerScene();
      else throw new Error(`no scene for ${id}`);
    }
    if (tl.film === "burn") {
      const ex = $("#s-burn-explorer");
      const shot = tl.shots.find((s) => s.id === "explorer");
      if (shot?.caption && !$(".caption", ex)) ex.insertAdjacentHTML("beforeend", `<div class="caption"><span class="chip warn"><span class="dot"></span>${shot.caption}</span></div>`);
    }
    for (const s of Object.values(S)) s.init?.();
    await document.fonts.load('400 40px "Instrument Serif"');
    await document.fonts.load('italic 400 40px "Instrument Serif"');
    await document.fonts.load('400 20px Geist');
    await document.fonts.load('400 20px "Geist Mono"');
    return true;
  };
  window.__seek = seek;
})();
