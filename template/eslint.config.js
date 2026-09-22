import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The platform serves apps under a strict CSP and the reviewer rejects diffs that
 * reach the network or execute strings. These rules fail the build instead.
 */
const FORBIDDEN_GLOBALS = [
  { name: "fetch", message: "Use ship.fn(name, input) from @pyre/app-sdk — apps may not call the network." },
  { name: "XMLHttpRequest", message: "Use ship.fn(name, input) from @pyre/app-sdk — apps may not call the network." },
  { name: "WebSocket", message: "Apps may not open sockets. Put server work in functions/*.js." },
  { name: "EventSource", message: "Apps may not open streams. Put server work in functions/*.js." },
  { name: "localStorage", message: "Use ship.kv (per-user, server-side) instead of localStorage." },
  { name: "sessionStorage", message: "Use ship.kv (per-user, server-side) instead of sessionStorage." },
  { name: "eval", message: "eval() is blocked by the app CSP." },
];

/**
 * Astral-plane characters (every emoji, incl. flames) and the BMP symbol blocks. Written
 * as surrogate pairs because esquery regexes have no `u` flag.
 */
const GLYPHS = "[\\uD83C-\\uDBFF][\\uDC00-\\uDFFF]|[\\u2600-\\u27BF]|\\uFE0F";
const GLYPH_MESSAGE = "No emoji or symbol glyphs: Pyre apps use words, not pictograms.";

/** Tailwind palette colours outside the Pyre theme; they do not exist in src/index.css. */
const OFF_PALETTE =
  "(^|[^a-z-])(bg|text|border|from|via|to|ring|fill|stroke|outline|shadow|accent|caret|decoration|divide|placeholder)-" +
  "(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)(-|$|[^a-z])";
const OFF_PALETTE_MESSAGE =
  "Off-palette colour: use the Pyre tokens from src/index.css (bg, surface, border, ink, violet, heat-1…6, danger).";

const FORBIDDEN_SYNTAX = [
  {
    selector: "JSXOpeningElement[name.name='script']",
    message: "No <script> tags: the CSP is script-src 'self'. Import modules instead.",
  },
  {
    selector: "CallExpression[callee.property.name='createElement'][arguments.0.value='script']",
    message: "No dynamically injected scripts: the CSP is script-src 'self'.",
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: "dangerouslySetInnerHTML injects untrusted markup; render React elements instead.",
  },
  {
    selector: "MemberExpression[object.name=/^(window|globalThis|self)$/][property.name='fetch']",
    message: "Use ship.fn(name, input) from @pyre/app-sdk — apps may not call the network.",
  },
  { selector: `JSXText[value=/${GLYPHS}/]`, message: GLYPH_MESSAGE },
  { selector: `Literal[value=/${GLYPHS}/]`, message: GLYPH_MESSAGE },
  { selector: `TemplateElement[value.raw=/${GLYPHS}/]`, message: GLYPH_MESSAGE },
  { selector: `Literal[value=/${OFF_PALETTE}/]`, message: OFF_PALETTE_MESSAGE },
  { selector: `TemplateElement[value.raw=/${OFF_PALETTE}/]`, message: OFF_PALETTE_MESSAGE },
];

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "playwright-report/**", "test-results/**", "test-results.json"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TypeScript already resolves identifiers; no-undef only produces false positives here.
    files: ["**/*.ts", "**/*.tsx"],
    rules: { "no-undef": "off" },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "functions/**/*.js"],
    rules: {
      "no-restricted-globals": ["error", ...FORBIDDEN_GLOBALS],
      "no-restricted-syntax": ["error", ...FORBIDDEN_SYNTAX],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
    },
  },
  {
    // Local tooling runs in Node, outside the sandboxed app bundle.
    files: ["dev/**/*.ts", "tests/**/*.ts", "*.config.ts", "*.config.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
