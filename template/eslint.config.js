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
