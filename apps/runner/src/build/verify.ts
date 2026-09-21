import type { Sandbox } from "e2b";
import type { Logger } from "pino";
import { z } from "zod";
import { APP_DIR, RUNNER_DIR, fileExists, readBytes, readText, run, runBackground } from "../sandbox/sandbox.js";

export type TestSummary = { passed: number; failed: number; output: string };
export type Screenshot = { label: string; png: Uint8Array<ArrayBuffer> };
export type LighthouseScores = { performance: number; accessibility: number; bestPractices: number; seo: number };

export type VerifyResult = {
  buildOk: boolean;
  buildOutput: string;
  test: TestSummary;
  screenshots: Screenshot[];
  lighthouse: LighthouseScores | null;
  lighthouseNote: string | null;
};

const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;

/**
 * Pinned, not floating: the E2B sandbox runs Node 20.9, and lighthouse >= 13
 * uses `import ... with { type: "json" }`, which that Node cannot parse — a
 * floating `npm i lighthouse` silently turned the whole audit into a
 * `SyntaxError: Unexpected token 'with'`. Bump this only against a sandbox
 * whose Node is new enough (check `node -v`, needs >= 20.10 for import attributes).
 */
const LIGHTHOUSE_VERSION = "12.8.2";

const tail = (s: string, n = 4000): string => (s.length > n ? s.slice(-n) : s);

/** Playwright JSON reporter: `stats` (≥1.30) or a walk of suites → specs. */
const PlaywrightReport = z.object({
  stats: z.object({ expected: z.number(), unexpected: z.number(), flaky: z.number().default(0) }).optional(),
  suites: z.array(z.any()).default([]),
});

const countSpecs = (node: unknown, acc: { passed: number; failed: number }): void => {
  if (!node || typeof node !== "object") return;
  if ("specs" in node && Array.isArray(node.specs)) {
    for (const spec of node.specs) {
      if (spec && typeof spec === "object" && "ok" in spec) {
        if (spec.ok) acc.passed++;
        else acc.failed++;
      }
    }
  }
  if ("suites" in node && Array.isArray(node.suites)) for (const s of node.suites) countSpecs(s, acc);
};

const SCREENSHOT_SCRIPT = `
import { createRequire } from "node:module";
const require = createRequire("${APP_DIR}/package.json");
const { chromium } = require("@playwright/test");
const targets = JSON.parse(process.argv[2]);
// /dev/shm is only 240 MB in an E2B sandbox and the VM has ~478 MB of RAM:
// without these flags chromium dies mapping shared memory instead of rendering.
const browser = await chromium.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--js-flags=--max-old-space-size=256"],
});
for (const t of targets) {
  const ctx = await browser.newContext({ viewport: t.viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto(t.url, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: t.out, fullPage: false });
    console.log("shot " + t.label);
  } catch (e) {
    console.error("shot failed " + t.label + ": " + (e && e.message ? e.message : e));
  } finally {
    await ctx.close();
  }
}
await browser.close();
`;

const LighthouseJson = z.object({
  categories: z.object({
    performance: z.object({ score: z.number().nullable() }),
    accessibility: z.object({ score: z.number().nullable() }),
    "best-practices": z.object({ score: z.number().nullable() }),
    seo: z.object({ score: z.number().nullable() }),
  }),
});

/** `npm run build` + `npm test` + screenshots + lighthouse against `vite preview`. */
export const verifyApp = async (sbx: Sandbox, log: Logger): Promise<VerifyResult> => {
  // `tsc --noEmit` twice plus a rollup build of the SDK's dependency tree takes
  // ~3 minutes on the sandbox's 2 vCPUs; leave room for an app that adds to it.
  const build = await run(sbx, "npm run build 2>&1", { cwd: APP_DIR, timeoutMs: 8 * 60_000 });
  const buildOutput = tail(build.stdout + build.stderr);
  if (build.exitCode !== 0) {
    return {
      buildOk: false,
      buildOutput,
      test: { passed: 0, failed: 0, output: "" },
      screenshots: [],
      lighthouse: null,
      lighthouseNote: null,
    };
  }

  await run(sbx, "rm -f test-results.json", { cwd: APP_DIR, timeoutMs: 10_000 });
  const testRun = await run(sbx, "npm test 2>&1", {
    cwd: APP_DIR,
    timeoutMs: 10 * 60_000,
    envs: { CI: "1", PLAYWRIGHT_JSON_OUTPUT_NAME: "test-results.json" },
  });
  const test: TestSummary = { passed: 0, failed: testRun.exitCode === 0 ? 0 : 1, output: tail(testRun.stdout + testRun.stderr) };
  if (await fileExists(sbx, `${APP_DIR}/test-results.json`)) {
    try {
      const report = PlaywrightReport.parse(JSON.parse(await readText(sbx, `${APP_DIR}/test-results.json`)));
      if (report.stats) {
        test.passed = report.stats.expected + report.stats.flaky;
        test.failed = report.stats.unexpected;
      } else {
        const acc = { passed: 0, failed: 0 };
        for (const s of report.suites) countSpecs(s, acc);
        test.passed = acc.passed;
        test.failed = acc.failed;
      }
      if (testRun.exitCode !== 0 && test.failed === 0) test.failed = 1;
    } catch (e) {
      log.warn({ err: e }, "could not parse playwright report");
    }
  }

  // Preview server for screenshots + lighthouse.
  const preview = await runBackground(sbx, `npx vite preview --port ${PREVIEW_PORT} --strictPort --host 127.0.0.1`, {
    cwd: APP_DIR,
    timeoutMs: 0,
  });
  const screenshots: Screenshot[] = [];
  let lighthouse: LighthouseScores | null = null;
  let lighthouseNote: string | null = null;
  try {
    const ready = await run(
      sbx,
      `for i in $(seq 1 30); do curl -sf -o /dev/null ${PREVIEW_URL}/ && exit 0; sleep 1; done; exit 1`,
      { timeoutMs: 45_000 },
    );
    if (ready.exitCode !== 0) {
      lighthouseNote = "preview server did not start";
      return { buildOk: true, buildOutput, test, screenshots, lighthouse, lighthouseNote };
    }

    await sbx.files.write(`${RUNNER_DIR}/shot.mjs`, SCREENSHOT_SCRIPT);
    const targets = [
      { label: "home", url: `${PREVIEW_URL}/`, viewport: { width: 1280, height: 800 }, out: `${RUNNER_DIR}/shot-home.png` },
      { label: "mobile", url: `${PREVIEW_URL}/`, viewport: { width: 390, height: 844 }, out: `${RUNNER_DIR}/shot-mobile.png` },
    ];
    const shot = await run(sbx, `node ${RUNNER_DIR}/shot.mjs '${JSON.stringify(targets).replace(/'/g, "'\\''")}'`, {
      cwd: APP_DIR,
      timeoutMs: 120_000,
    });
    if (shot.exitCode !== 0) log.warn({ out: tail(shot.stdout + shot.stderr, 800) }, "screenshot script failed");
    for (const t of targets) {
      if (await fileExists(sbx, t.out)) screenshots.push({ label: t.label, png: await readBytes(sbx, t.out) });
    }

    const chrome = await run(sbx, `node -e "console.log(require('@playwright/test').chromium.executablePath())"`, {
      cwd: APP_DIR,
      timeoutMs: 30_000,
    });
    const chromePath = chrome.stdout.trim().split("\n").pop() ?? "";
    const lh = await run(
      sbx,
      `([ -x node_modules/.bin/lighthouse ] || npm i --no-audit --no-fund --loglevel=error lighthouse@${LIGHTHOUSE_VERSION}) && rm -f lh.json && ./node_modules/.bin/lighthouse ${PREVIEW_URL}/ --output=json --output-path=./lh.json --only-categories=performance,accessibility,best-practices,seo --chrome-flags="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage" --quiet`,
      { cwd: RUNNER_DIR, timeoutMs: 4 * 60_000, envs: chromePath ? { CHROME_PATH: chromePath } : {} },
    );
    if (lh.exitCode === 0 && (await fileExists(sbx, `${RUNNER_DIR}/lh.json`))) {
      const parsed = LighthouseJson.safeParse(JSON.parse(await readText(sbx, `${RUNNER_DIR}/lh.json`)));
      if (parsed.success) {
        const c = parsed.data.categories;
        lighthouse = {
          performance: Math.round((c.performance.score ?? 0) * 100),
          accessibility: Math.round((c.accessibility.score ?? 0) * 100),
          bestPractices: Math.round((c["best-practices"].score ?? 0) * 100),
          seo: Math.round((c.seo.score ?? 0) * 100),
        };
      } else lighthouseNote = "lighthouse report unreadable";
    } else {
      lighthouseNote = `lighthouse skipped: ${tail(lh.stderr || lh.stdout, 300).trim() || `exit ${lh.exitCode}`}`;
    }
  } finally {
    await preview.kill().catch(() => undefined);
  }
  return { buildOk: true, buildOutput, test, screenshots, lighthouse, lighthouseNote };
};
