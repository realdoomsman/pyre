// Generates mark.svg, mark-mono-light.svg, mark-mono-dark.svg, wordmark.svg, lockup.svg, favicon.svg.
// Usage (from repo root):
//   cd .tmp/brand && npm i opentype.js@1.3.4 && curl -sLO https://github.com/Instrument/instrument-serif/raw/main/fonts/ttf/InstrumentSerif-Regular.ttf
//   node marketing/brand/pyre/tools/gen-svg.mjs
// The wordmark is converted to outlines so the SVGs never depend on an installed font.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), ".tmp/brand/package.json"));
const opentype = require("opentype.js");
const OUT = resolve(process.cwd(), "marketing/brand/pyre");
const font = opentype.loadSync(resolve(process.cwd(), ".tmp/brand/InstrumentSerif-Regular.ttf"));

// ---------- palette ----------
const P = {
  canvas: "#0A0A0C",
  tile: "#141418",
  tileTop: "#1C1C22",
  ink: "#F3F2EE",
  ramp: ["#1C1B2E", "#3B2F7A", "#7A66F5", "#3E8BFF", "#9CD2FF", "#E9F1FF"],
};

// ---------- mark ----------
// 512 unit tile, radius 22%. Heat ramp rises from the bottom edge; a white-hot core sits at bottom-centre.
const S = 512;
const R = Math.round(S * 0.22);

function markDefs(id) {
  return `
  <defs>
    <linearGradient id="${id}-body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.tileTop}"/>
      <stop offset="0.30" stop-color="${P.tile}"/>
      <stop offset="0.50" stop-color="${P.ramp[0]}"/>
      <stop offset="0.66" stop-color="${P.ramp[1]}"/>
      <stop offset="0.80" stop-color="${P.ramp[2]}"/>
      <stop offset="0.90" stop-color="${P.ramp[3]}"/>
      <stop offset="0.96" stop-color="${P.ramp[4]}"/>
      <stop offset="1" stop-color="${P.ramp[5]}"/>
    </linearGradient>
    <radialGradient id="${id}-core" cx="0.5" cy="1.0" r="1.0" gradientTransform="translate(0.5,1.0) scale(1,0.30) translate(-0.5,-1.0)">
      <stop offset="0" stop-color="${P.ramp[5]}" stop-opacity="1"/>
      <stop offset="0.12" stop-color="${P.ramp[4]}" stop-opacity="0.8"/>
      <stop offset="0.30" stop-color="${P.ramp[3]}" stop-opacity="0.4"/>
      <stop offset="0.55" stop-color="${P.ramp[2]}" stop-opacity="0.14"/>
      <stop offset="0.8" stop-color="${P.ramp[2]}" stop-opacity="0.03"/>
      <stop offset="1" stop-color="${P.ramp[2]}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id}-lip" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.ramp[5]}" stop-opacity="0"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0.95"/>
    </linearGradient>
    <linearGradient id="${id}-edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.10"/>
      <stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0.02"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${id}-sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.06"/>
      <stop offset="0.38" stop-color="#FFFFFF" stop-opacity="0.012"/>
      <stop offset="0.6" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="${id}-clip"><rect width="${S}" height="${S}" rx="${R}"/></clipPath>
  </defs>`;
}

function markBody(id) {
  return `
  <g clip-path="url(#${id}-clip)">
    <rect width="${S}" height="${S}" fill="url(#${id}-body)"/>
    <rect width="${S}" height="${S}" fill="url(#${id}-sheen)"/>
    <rect width="${S}" height="${S}" fill="url(#${id}-core)"/>
    <rect y="${S * 0.972}" width="${S}" height="${S * 0.028}" fill="url(#${id}-lip)"/>
    <path d="M0 ${S * 0.60} Q${S / 2} ${S * 0.46} ${S} ${S * 0.60}" fill="none" stroke="${P.ramp[5]}" stroke-opacity="0.13" stroke-width="2"/>
  </g>
  <rect x="1.5" y="1.5" width="${S - 3}" height="${S - 3}" rx="${R - 1.5}" fill="none" stroke="url(#${id}-edge)" stroke-width="3"/>`;
}

function markSvg({ id = "pyre", size = S } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${size}" height="${size}" role="img" aria-label="Pyre">${markDefs(id)}${markBody(id)}
</svg>
`;
}

// Mono: same silhouette, split by a curved hairline of negative space — the thermal boundary.
// Top block = obsidian body, bottom block = heat. Reads at 16px as a tile with a lit base.
function markMonoSvg(color) {
  const gap = S * 0.07;
  const yEdge = S * 0.60; // boundary at the sides
  const yMid = S * 0.53; // boundary at centre (heat bulges upward)
  const ctrl = yMid - (yEdge - yMid);
  const top = `M0 0 H${S} V${yEdge} Q${S / 2} ${ctrl} 0 ${yEdge} Z`;
  const bottom = `M0 ${yEdge + gap} Q${S / 2} ${ctrl + gap} ${S} ${yEdge + gap} V${S} H0 Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="Pyre">
  <defs><clipPath id="c"><rect width="${S}" height="${S}" rx="${R}"/></clipPath></defs>
  <g clip-path="url(#c)" fill="${color}"><path d="${top}"/><path d="${bottom}"/></g>
</svg>
`;
}

// ---------- wordmark ----------
const TEXT = "Pyre";
const EM = 400; // font-size in SVG units
const TRACK = -0.02 * EM; // -0.02em per PLAN §4
function wordmarkPath() {
  let x = 0;
  const glyphs = font.stringToGlyphs(TEXT);
  const parts = [];
  let bbox = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  glyphs.forEach((g, i) => {
    const p = g.getPath(x, 0, EM);
    const b = p.getBoundingBox();
    bbox = { x1: Math.min(bbox.x1, b.x1), y1: Math.min(bbox.y1, b.y1), x2: Math.max(bbox.x2, b.x2), y2: Math.max(bbox.y2, b.y2) };
    parts.push(p.toPathData(2));
    const kern = i < glyphs.length - 1 ? font.getKerningValue(g, glyphs[i + 1]) : 0;
    x += ((g.advanceWidth + kern) / font.unitsPerEm) * EM + TRACK;
  });
  const cap = (font.tables.os2.sCapHeight / font.unitsPerEm) * EM;
  return { d: parts.join(" "), bbox, cap, baseline: 0 };
}

const wm = wordmarkPath();
const wmW = wm.bbox.x2 - wm.bbox.x1;
const wmH = wm.bbox.y2 - wm.bbox.y1;

function wordmarkSvg(color = P.ink) {
  const pad = 0;
  const vb = `${(wm.bbox.x1 - pad).toFixed(2)} ${(wm.bbox.y1 - pad).toFixed(2)} ${(wmW + pad * 2).toFixed(2)} ${(wmH + pad * 2).toFixed(2)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${wmW.toFixed(0)}" height="${wmH.toFixed(0)}" role="img" aria-label="Pyre">
  <path fill="${color}" d="${wm.d}"/>
</svg>
`;
}

// ---------- lockup ----------
// Mark height = cap height × 1.12; the heat edge sits on the baseline. Gap = 0.42 × mark.
function lockupSvg(ink = P.ink) {
  const mh = wm.cap * 1.12;
  const scale = mh / S;
  const gap = mh * 0.36;
  const markX = 0;
  const markY = -mh; // bottom on baseline (y=0)
  const wordX = mh + gap - wm.bbox.x1;
  const x1 = 0, y1 = Math.min(markY, wm.bbox.y1), x2 = wordX + wm.bbox.x2, y2 = Math.max(0, wm.bbox.y2);
  const w = x2 - x1, h = y2 - y1;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x1.toFixed(2)} ${y1.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" role="img" aria-label="Pyre">${markDefs("lk")}
  <g transform="translate(${markX} ${markY.toFixed(2)}) scale(${scale.toFixed(5)})">${markBody("lk")}
  </g>
  <path fill="${ink}" transform="translate(${wordX.toFixed(2)} 0)" d="${wm.d}"/>
</svg>
`;
}

writeFileSync(resolve(OUT, "mark.svg"), markSvg());
writeFileSync(resolve(OUT, "favicon.svg"), markSvg({ id: "fav" }));
writeFileSync(resolve(OUT, "mark-mono-light.svg"), markMonoSvg("#FFFFFF"));
writeFileSync(resolve(OUT, "mark-mono-dark.svg"), markMonoSvg("#000000"));
writeFileSync(resolve(OUT, "wordmark.svg"), wordmarkSvg());
writeFileSync(resolve(OUT, "wordmark-on-light.svg"), wordmarkSvg("#141311"));
writeFileSync(resolve(OUT, "lockup.svg"), lockupSvg());
writeFileSync(resolve(OUT, "lockup-on-light.svg"), lockupSvg("#141311"));
console.log("wordmark bbox", wm.bbox, "cap", wm.cap);
