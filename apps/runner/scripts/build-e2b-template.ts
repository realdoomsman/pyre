/**
 * Builds the optional prebaked E2B template. Two things it buys:
 *
 *  1. **A VM with real memory.** E2B's stock `base` template is a 478 MB VM
 *     with no swap, which is what made `npm install` of the app template die
 *     (`Reached heap limit`, then plain OOM kills). Template metadata is the
 *     only place sandbox memory can be set — `Sandbox.create` has no such
 *     option — so 4 GB has to be baked here.
 *  2. **Skipping the slow parts of bootstrap.** `src/sandbox/setup.ts` probes
 *     for each of the paths below and skips the corresponding step when it
 *     exists, taking first-build bootstrap from minutes to seconds:
 *       /opt/pyre/prebuilt.json        marker, also the human-readable manifest
 *       /home/user/runner/node_modules @anthropic-ai/claude-agent-sdk, lighthouse, @playwright/test
 *       /home/user/.cache/ms-playwright chromium + its OS deps
 *       /opt/pyre/app-node_modules     the app template's deps, hardlinked into
 *                                      the app when its lockfile hash matches
 *       /opt/pyre/app-lock.sha256      sha256 of the baked template/package-lock.json
 *
 * Usage, from anywhere in the repo, with `E2B_API_KEY` in the environment:
 *   npx tsx apps/runner/scripts/build-e2b-template.ts [name]
 * Default name `pyre-builder`. Afterwards set `E2B_TEMPLATE=<name>` for the
 * runner (the runner defaults to `pyre-builder`; `E2B_TEMPLATE=base` falls back to the stock image — see setup.ts).
 * Re-run whenever `template/package-lock.json` or `LIGHTHOUSE_VERSION` changes
 * (Playwright is read from the lockfile, never pinned here). A stale bake is
 * harmless: the lockfile hash stops matching and bootstrap does a real `npm ci`.
 *
 * Measured on the app template — bootstrap 115s -> 22s, verify 255s -> 91s.
 *
 * No Docker required: e2b 2.x builds the image server-side. That builder does
 * not exist in e2b 1.13, which is what `apps/runner` resolves from its own
 * nested `node_modules`; the repo root carries `e2b ^2.50.0` in
 * devDependencies, so this script resolves that copy explicitly rather than
 * moving the runner's *runtime* SDK across a major version for a build-time
 * convenience.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Must match `src/build/verify.ts`'s pin: lighthouse >= 13 uses import
// attributes the sandbox's Node 20.9 cannot parse.
const LIGHTHOUSE_VERSION = "12.8.2";
const MEMORY_MB = 4096;
const CPU_COUNT = 2;
const RUNNER_DIR = "/home/user/runner";

/**
 * The slice of the e2b 2.x template builder this script uses. Declared locally
 * because the ambient `e2b` types in `apps/runner` are 1.13's, which has no
 * template builder at all.
 */
type Builder = {
  runCmd(command: string | string[], options?: { user?: string }): Builder;
  copy(src: string | string[], dest: string, options?: { user?: string; mode?: number }): Builder;
  setEnvs(envs: Record<string, string>): Builder;
  setUser(user: string): Builder;
  setWorkdir(dir: string): Builder;
};

type LogEntry = { level?: string; message?: string; timestamp?: string };

type TemplateSdk = {
  Template: ((options?: { fileContextPath?: string; fileIgnorePatterns?: string[] }) => {
    fromBaseImage(): Builder;
  }) & {
    build(
      template: unknown,
      name: string,
      options: {
        apiKey?: string;
        cpuCount?: number;
        memoryMB?: number;
        minFreeDiskMb?: number;
        skipCache?: boolean;
        onBuildLogs?: (entry: LogEntry) => void;
      },
    ): Promise<{ templateID?: string; buildID?: string }>;
  };
};

const main = async (): Promise<void> => {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY is required");
  const name = process.argv[2] ?? "pyre-builder";
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  const sdk = createRequire(resolve(repoRoot, "package.json"))("e2b") as TemplateSdk;
  if (typeof sdk.Template?.build !== "function") {
    throw new Error("the repo root's `e2b` has no Template builder; run `npm install` at the root (needs e2b >= 2.x)");
  }

  // Read, never pin: baking a different Playwright than the app's lockfile
  // resolves means baking a chromium revision the app then refuses to use, and
  // the whole point of the bake is to skip that download.
  const lock = JSON.parse(readFileSync(resolve(repoRoot, "template/package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  const playwrightVersion = lock.packages?.["node_modules/@playwright/test"]?.version;
  if (!playwrightVersion) {
    throw new Error("template/package-lock.json has no resolved @playwright/test version; regenerate the lockfile");
  }

  const manifest = JSON.stringify({
    builtAt: new Date().toISOString(),
    playwright: playwrightVersion,
    memoryMB: MEMORY_MB,
    bakes: ["runner-deps", "chromium", "app-node_modules"],
  });

  const template = sdk
    .Template({ fileContextPath: repoRoot, fileIgnorePatterns: ["**/node_modules/**", "**/.git/**"] })
    .fromBaseImage()
    .setEnvs({
      PLAYWRIGHT_BROWSERS_PATH: "/home/user/.cache/ms-playwright",
      CI: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_progress: "false",
      npm_config_loglevel: "error",
    })
    // Runner-side deps: the agent SDK the in-sandbox driver imports, plus the
    // two tools the verify stage would otherwise install mid-build.
    .runCmd(
      [
        `mkdir -p ${RUNNER_DIR}`,
        `cd ${RUNNER_DIR} && npm init -y >/dev/null`,
        `cd ${RUNNER_DIR} && npm i @anthropic-ai/claude-agent-sdk lighthouse@${LIGHTHOUSE_VERSION} @playwright/test@${playwrightVersion}`,
        `cd ${RUNNER_DIR} && npx playwright install --with-deps chromium`,
      ],
      { user: "root" },
    )
    // The app template's dependency tree, installed in the same layout the
    // sandbox uses (`app/` next to `app-sdk/`) so `@pyre/app-sdk`'s relative
    // symlink still resolves after the tree is hardlinked into place. Only the
    // sdk's package.json is needed: npm links `file:` deps rather than copying
    // them, and setup.ts unpacks the real (freshly built) sdk at run time.
    .copy(["template/package.json", "template/package-lock.json"], "/home/user/app/", { user: "root" })
    .copy("packages/app-sdk/package.json", "/home/user/app-sdk/", { user: "root" })
    .runCmd(
      [
        "cd /home/user/app && npm ci",
        "mkdir -p /opt/pyre && mv /home/user/app/node_modules /opt/pyre/app-node_modules",
        "sha256sum /home/user/app/package-lock.json | cut -d' ' -f1 > /opt/pyre/app-lock.sha256",
        "rm -rf /home/user/app /home/user/app-sdk",
        `printf '%s' '${manifest}' > /opt/pyre/prebuilt.json`,
        // `user` must own it: the sandbox hardlinks this tree into the app, and
        // protected_hardlinks forbids linking files you do not own.
        "chown -R user:user /opt/pyre",
      ],
      { user: "root" },
    )
    .setUser("user")
    .setWorkdir("/home/user");

  console.log(`building E2B template "${name}" (${MEMORY_MB} MB, ${CPU_COUNT} vCPU) — no Docker needed, builds server-side`);
  const info = await sdk.Template.build(template, name, {
    apiKey,
    cpuCount: CPU_COUNT,
    memoryMB: MEMORY_MB,
    minFreeDiskMb: 4096,
    onBuildLogs: (entry) => {
      if (entry.message) console.log(entry.message.replace(/\s+$/, ""));
    },
  });
  console.log(`\nbuilt template ${info.templateID ?? name}. Set E2B_TEMPLATE=${name} for the runner.`);
};

await main().catch((e: unknown) => {
  const err = e as { message?: string; stackTrace?: string };
  console.error(`\ntemplate build failed: ${err.message ?? String(e)}`);
  if (err.stackTrace) console.error(err.stackTrace);
  process.exit(1);
});
