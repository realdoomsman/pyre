import { readFile } from "node:fs/promises";
import type { Sandbox } from "e2b";
import type { Logger } from "pino";
import { assets } from "./assets.js";
import { APP_DIR, HOME, RUNNER_DIR, SDK_DIR, TEMPLATE_DIR, run, setSandboxEnvs, writeFile } from "./sandbox.js";
import { packDirs } from "./tar.js";

export type BootstrapOpts = {
  /** `owner/name` of the app's GitHub repo when it already exists. */
  repoFullName: string | null;
  log: Logger;
};

/** Paths baked by `scripts/build-e2b-template.ts`; every one is probed, never assumed. */
const PREBUILT = {
  marker: "/opt/pyre/prebuilt.json",
  modules: "/opt/pyre/app-node_modules",
  lockSha: "/opt/pyre/app-lock.sha256",
} as const;

const SWAP_FILE = "/swapfile";
const SWAP_MB = 2048;

/** Single-quote for POSIX sh, so generated step bodies need no escaping discipline at the call site. */
const shq = (s: string): string => `'${s.split("'").join("'\\''")}'`;

/**
 * Report what the VM actually has, and on a small one (E2B's stock `base` is a
 * 478 MB VM with no swap) add a swapfile first: without it even a lockfile
 * install gets OOM-killed while unpacking ~750 packages. Kept separate from the
 * main script because its output sizes V8's heap for every command that follows.
 */
const PROBE = `
set -uo pipefail
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 2048 ] && [ "$(free -m | awk '/^Swap:/{print $2}')" -lt 1024 ]; then
  sudo -n sh -c 'fallocate -l ${SWAP_MB}M ${SWAP_FILE} && chmod 600 ${SWAP_FILE} && mkswap ${SWAP_FILE} >/dev/null && swapon ${SWAP_FILE}' >/dev/null 2>&1 \\
    || echo "swapfail 1"
fi
free -m | awk '/^Mem:/{print "mem " $2} /^Swap:/{print "swap " $2}'
nproc | awk '{print "cpus " $1}'
node -e 'console.log("heap", Math.round(require("v8").getHeapStatistics().heap_size_limit/1048576))'
if [ -f ${PREBUILT.marker} ]; then echo "prebuilt 1"; else echo "prebuilt 0"; fi
`;

type Step = { name: string; timeoutSec: number; cmd: string; soft?: boolean };

/**
 * `step` runs one labelled unit under a hard timeout and exits the script on
 * failure; `soft_step` warns and continues. Both always print a marker, so the
 * caller can name the failing step even when output is truncated.
 */
const PROLOGUE = `
set -uo pipefail
run_step() {
  local marker=$1 name=$2 secs=$3 cmd=$4 start=$SECONDS code=0
  echo "::step $name"
  timeout -k 10 "$secs" bash -euo pipefail -c "$cmd" || code=$?
  if [ "$code" = 0 ]; then
    echo "::ok $name $((SECONDS - start))s"
    return 0
  fi
  local why="exit $code"
  [ "$code" = 124 ] && why="TIMEOUT after \${secs}s"
  [ "$code" = 137 ] && why="KILLED after $((SECONDS - start))s (timeout grace or out of memory)"
  echo "::$marker $name $why"
  return "$code"
}
step() { run_step fail "$@" || exit $?; }
soft_step() { run_step warn "$@" || true; }
`;

const steps = (opts: { cloneUrl: string | null; prebuilt: boolean }): Step[] => [
  {
    name: "unpack",
    timeoutSec: 120,
    cmd: `cd ${HOME} && tar xzf bootstrap.tgz && rm -f bootstrap.tgz && test -f ${TEMPLATE_DIR}/package.json && test -f ${SDK_DIR}/package.json`,
  },
  // Reachability first: a deleted/private/misnamed repo must error here in
  // seconds, not block on a credential prompt inside a non-interactive VM.
  {
    name: "probe-repo",
    timeoutSec: 60,
    soft: true,
    cmd: opts.cloneUrl
      ? `rm -f /tmp/pyre-do-clone
if git -c credential.helper= ls-remote --heads ${shq(opts.cloneUrl)} >/tmp/pyre-refs 2>&1; then
  if [ -s /tmp/pyre-refs ]; then
    touch /tmp/pyre-do-clone; echo "repo has $(wc -l < /tmp/pyre-refs) branch(es), cloning"
  else
    echo "repo exists but is empty, seeding from template"
  fi
else
  echo "repo unreachable, seeding from template: $(tr '\\n' ' ' < /tmp/pyre-refs | tail -c 300)"
  exit 1
fi`
      : `echo "no repo yet, seeding from template"`,
  },
  {
    name: "clone",
    timeoutSec: 240,
    cmd: opts.cloneUrl
      ? `if [ -f /tmp/pyre-do-clone ]; then rm -rf ${APP_DIR} && git -c credential.helper= clone --depth 50 ${shq(opts.cloneUrl)} ${APP_DIR}; else echo "skipped"; fi`
      : `echo "skipped"`,
  },
  {
    name: "seed",
    timeoutSec: 120,
    cmd: `mkdir -p ${APP_DIR} && if [ -f ${APP_DIR}/package.json ]; then echo "app already has package.json"; else cp -R ${TEMPLATE_DIR}/. ${APP_DIR}/ && echo "seeded from template"; fi`,
  },
  {
    name: "git-init",
    timeoutSec: 60,
    cmd: `cd ${APP_DIR} && if [ ! -d .git ]; then git init -q -b main; fi && git config user.email "bot@pyre.fun" && git config user.name "pyre-bot"`,
  },
  {
    name: "runner-deps",
    timeoutSec: 300,
    cmd: `cd ${RUNNER_DIR} && if [ ! -f package.json ]; then npm init -y >/dev/null; fi
if [ -d node_modules/@anthropic-ai/claude-agent-sdk ]; then echo "prebaked"; else npm i @anthropic-ai/claude-agent-sdk; fi`,
  },
  // `npm install` resolves the whole tree from the registry and dies parsing
  // packuments in a 259 MB heap; `npm ci` reads the committed lockfile instead.
  // The agent may legitimately add a dependency, which puts the lockfile out of
  // sync — that case falls back to a full install rather than failing the build.
  {
    name: "app-deps",
    timeoutSec: 600,
    cmd: `cd ${APP_DIR}
reused=0
if [ -f package-lock.json ] && [ -d ${PREBUILT.modules} ] && [ "$(sha256sum package-lock.json | cut -d' ' -f1)" = "$(cat ${PREBUILT.lockSha} 2>/dev/null)" ]; then
  # Hardlinks make this instant, but they need the baked tree to be owned by
  # this user (protected_hardlinks); fall back to a plain copy, then to a real install.
  rm -rf node_modules
  if cp -al ${PREBUILT.modules} node_modules 2>/dev/null; then
    reused=1; echo "hardlinked prebaked node_modules"
  else
    rm -rf node_modules
    if cp -a ${PREBUILT.modules} node_modules; then reused=1; echo "copied prebaked node_modules"; else rm -rf node_modules; fi
  fi
fi
if [ "$reused" = 0 ]; then
  if [ -f package-lock.json ] && npm ci; then
    echo "installed from package-lock.json"
  else
    echo "::warn lockfile missing or out of sync with package.json, resolving from registry"
    npm install
  fi
fi`,
  },
  // The cache is keyed by chromium *revision*, not by "some chromium exists":
  // a prebuilt template holding a different Playwright's browser is a cache
  // miss, so ask the app's own Playwright where its binary should be.
  {
    name: "chromium",
    timeoutSec: 480,
    cmd: `cd ${APP_DIR} && if node -e "require('node:fs').accessSync(require('@playwright/test').chromium.executablePath())" 2>/dev/null; then
  echo "chromium already cached"
else
  npx --yes playwright install ${opts.prebuilt ? "" : "--with-deps "}chromium
fi`,
  },
  // Cheap assertion that the toolchain the verify stage needs is actually here,
  // so a broken install surfaces as a named bootstrap failure and not as a
  // confusing `npm run build` error ten minutes later.
  {
    name: "doctor",
    timeoutSec: 90,
    cmd: `cd ${APP_DIR} && node -v && npm -v && node --print "require('v8').getHeapStatistics().heap_size_limit/1048576 + ' MB heap'" \\
  && node -e "for (const m of ['vite','typescript','@playwright/test']) require.resolve(m + '/package.json')" \\
  && node -e "const p=require('@playwright/test').chromium.executablePath(); require('node:fs').accessSync(p); console.log('chromium ' + p)" \\
  && test -d node_modules/@pyre/app-sdk && echo "app-sdk linked"`,
  },
];

/**
 * Prepare `/home/user`: app-sdk + template + runner script from our assets, app
 * source from GitHub (when the repo exists and has commits) or the template,
 * runner deps (`@anthropic-ai/claude-agent-sdk`), app deps and a chromium for
 * Playwright.
 *
 * Also installs the environment every later command in this sandbox inherits —
 * a V8 heap sized from the VM's real memory, quiet/low-concurrency npm, and
 * non-interactive git. Idempotent against a prebuilt E2B template that already
 * has the heavy parts.
 */
export const bootstrapSandbox = async (sbx: Sandbox, opts: BootstrapOpts): Promise<void> => {
  const probe = await run(sbx, PROBE, { timeoutMs: 180_000 });
  const num = (key: string): number => Number(new RegExp(`^${key} (\\d+)$`, "m").exec(probe.stdout)?.[1] ?? 0);
  const ram = num("mem");
  const swap = num("swap");
  const prebuilt = num("prebuilt") === 1;
  // V8 derives its default old-space from container RAM: 259 MB on a 478 MB VM,
  // which npm cannot fit. Size it from RAM + swap, leaving room for everything else.
  const heap = Math.max(512, Math.min(4096, Math.floor(((ram + swap) * 3) / 4)));
  opts.log.info(
    { ram, swap, cpus: num("cpus"), defaultHeapMb: num("heap"), heapMb: heap, prebuilt },
    "sandbox capacity",
  );
  // Tight only matters when both are small: a 4 GB template needs no swap, and
  // the 478 MB `base` VM cannot install anything without it.
  if (ram + swap < 2048) {
    opts.log.warn({ ram, swap }, "sandbox is memory constrained and swap could not be added; npm may be OOM-killed");
  }

  setSandboxEnvs(sbx, {
    CI: "1",
    NODE_OPTIONS: `--max-old-space-size=${heap}`,
    // A sandbox has no way to answer a credential prompt; make git say so instead of hanging.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_progress: "false",
    npm_config_update_notifier: "false",
    npm_config_loglevel: "error",
    npm_config_maxsockets: "4",
    npm_config_fetch_timeout: "120000",
    npm_config_fetch_retries: "3",
  });

  const tgz = await packDirs([
    { dir: assets.templateDir, prefix: "template" },
    { dir: assets.appSdkDir, prefix: "app-sdk", skipTopLevel: { src: true, "tsconfig.json": true } },
  ]);
  await run(sbx, `mkdir -p ${APP_DIR} ${SDK_DIR} ${RUNNER_DIR} ${TEMPLATE_DIR}`, { timeoutMs: 30_000 });
  await writeFile(sbx, `${HOME}/bootstrap.tgz`, tgz);
  await writeFile(sbx, `${RUNNER_DIR}/pyre-runner.mjs`, await readFile(assets.runnerScript, "utf8"));

  const cloneUrl = opts.repoFullName ? `https://github.com/${opts.repoFullName}.git` : null;
  const script = [
    PROLOGUE,
    ...steps({ cloneUrl, prebuilt }).map(
      (s) => `${s.soft ? "soft_step" : "step"} ${s.name} ${s.timeoutSec} ${shq(s.cmd)}`,
    ),
    'echo "::done"',
  ].join("\n");
  await writeFile(sbx, `${RUNNER_DIR}/bootstrap.sh`, script);

  // Track the step in flight and the last 40 lines, so a failure names where it
  // died even when the whole script is killed by the outer timeout.
  let step = "start";
  let failure: string | null = null;
  const lines: string[] = [];
  let pending = "";
  const consume = (chunk: string): void => {
    pending += chunk;
    for (;;) {
      const nl = pending.indexOf("\n");
      if (nl < 0) break;
      const line = pending.slice(0, nl).trimEnd();
      pending = pending.slice(nl + 1);
      if (line.startsWith("::step ")) {
        step = line.slice(7);
        opts.log.debug({ step }, "bootstrap step");
      } else if (line.startsWith("::fail ")) failure = line.slice(7);
      else if (line.startsWith("::warn ")) opts.log.warn({ step, detail: line.slice(7) }, "bootstrap warning");
      lines.push(line);
      if (lines.length > 40) lines.shift();
    }
  };

  const r = await run(sbx, `bash ${RUNNER_DIR}/bootstrap.sh`, {
    timeoutMs: 20 * 60_000,
    onStdout: consume,
    onStderr: consume,
  });
  if (r.exitCode !== 0) {
    const where = failure ?? `${step} (no failure marker: step did not finish)`;
    const tail = lines.join("\n");
    opts.log.error({ exitCode: r.exitCode, step, failure, tail }, "sandbox bootstrap failed");
    throw new Error(`sandbox bootstrap failed at ::${where} (exit ${r.exitCode})\n${tail.slice(-1500)}`);
  }
};
