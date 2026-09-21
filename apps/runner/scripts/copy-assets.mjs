// Copies everything the runner ships into sandboxes next to the compiled code:
//   dist/assets/template/          ← template/ (repo root)
//   dist/assets/app-sdk/           ← packages/app-sdk/package.json + dist/
//   dist/assets/pyre-runner.mjs    ← src/sandbox/pyre-runner.mjs
// `src/sandbox/assets.ts` prefers dist/assets when present and falls back to the repo tree in dev.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const root = resolve(pkg, "../..");
const out = resolve(pkg, "dist/assets");

const SKIP = new Set(["node_modules", "dist", ".git", "test-results", "test-results.json", "playwright-report"]);
const filter = (src) => !SKIP.has(src.split(/[\\/]/).pop());

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const template = resolve(root, "template");
if (!existsSync(template)) throw new Error(`template directory missing: ${template}`);
cpSync(template, resolve(out, "template"), { recursive: true, filter });

const sdk = resolve(root, "packages/app-sdk");
if (!existsSync(resolve(sdk, "dist"))) throw new Error(`@pyre/app-sdk is not built: ${resolve(sdk, "dist")}`);
mkdirSync(resolve(out, "app-sdk"), { recursive: true });
cpSync(resolve(sdk, "package.json"), resolve(out, "app-sdk/package.json"));
cpSync(resolve(sdk, "dist"), resolve(out, "app-sdk/dist"), { recursive: true });
if (existsSync(resolve(sdk, "README.md"))) cpSync(resolve(sdk, "README.md"), resolve(out, "app-sdk/README.md"));

cpSync(resolve(pkg, "src/sandbox/pyre-runner.mjs"), resolve(out, "pyre-runner.mjs"));

console.log(`runner assets copied to ${out}`);
