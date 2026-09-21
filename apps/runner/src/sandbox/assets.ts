import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Files shipped into every sandbox. In production `scripts/copy-assets.mjs`
 * places them under `dist/assets`; during `tsx` development we read straight
 * from the monorepo.
 */
export type Assets = {
  templateDir: string;
  appSdkDir: string;
  runnerScript: string;
};

const here = dirname(fileURLToPath(import.meta.url));
const bundled = resolve(here, "../assets");
const repoRoot = resolve(here, "../../../..");

export const assets: Assets = existsSync(resolve(bundled, "template"))
  ? {
      templateDir: resolve(bundled, "template"),
      appSdkDir: resolve(bundled, "app-sdk"),
      runnerScript: resolve(bundled, "pyre-runner.mjs"),
    }
  : {
      templateDir: resolve(repoRoot, "template"),
      appSdkDir: resolve(repoRoot, "packages/app-sdk"),
      runnerScript: resolve(here, "pyre-runner.mjs"),
    };
