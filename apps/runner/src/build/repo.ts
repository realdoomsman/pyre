import type { Sandbox } from "e2b";
import { gitAuthHeader } from "../lib/github.js";
import { APP_DIR, run } from "../sandbox/sandbox.js";

export type ChangeSet = { diff: string; files: string[]; manifest: string };

/** Stage everything and return the staged diff, tracked file list and manifest text. */
export const stageAndDiff = async (sbx: Sandbox): Promise<ChangeSet> => {
  await run(sbx, "git add -A", { cwd: APP_DIR, timeoutMs: 60_000 });
  const [diff, files, manifest] = await Promise.all([
    run(sbx, "git diff --cached --no-color --stat=200 && git diff --cached --no-color -- . ':(exclude)package-lock.json'", {
      cwd: APP_DIR,
      timeoutMs: 60_000,
    }),
    run(sbx, "git ls-files", { cwd: APP_DIR, timeoutMs: 30_000 }),
    run(sbx, "cat pyre.manifest.json", { cwd: APP_DIR, timeoutMs: 10_000 }),
  ]);
  return {
    diff: diff.stdout,
    files: files.stdout.split("\n").filter(Boolean),
    manifest: manifest.exitCode === 0 ? manifest.stdout : "",
  };
};

/**
 * Commit staged changes and push `main` to the app repo. The GitHub token is
 * passed only as a one-shot `http.extraheader`, never written into the sandbox.
 */
export const commitAndPush = async (
  sbx: Sandbox,
  opts: { fullName: string; message: string },
): Promise<{ sha: string; url: string }> => {
  const commit = await run(sbx, 'git diff --cached --quiet || git commit -q -m "$PYRE_COMMIT_MSG"', {
    cwd: APP_DIR,
    timeoutMs: 60_000,
    envs: { PYRE_COMMIT_MSG: opts.message },
  });
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${(commit.stdout + commit.stderr).slice(-500)}`);
  const head = await run(sbx, "git rev-parse HEAD", { cwd: APP_DIR, timeoutMs: 10_000 });
  const sha = head.stdout.trim();
  if (!sha) throw new Error("git rev-parse HEAD produced no sha");
  const remote = `https://github.com/${opts.fullName}.git`;
  const push = await run(
    sbx,
    `git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "$REMOTE" || git remote add origin "$REMOTE"; git -c http.extraheader="$GIT_AUTH" push -q -u origin HEAD:main`,
    { cwd: APP_DIR, timeoutMs: 180_000, envs: { REMOTE: remote, GIT_AUTH: gitAuthHeader() } },
  );
  if (push.exitCode !== 0) throw new Error(`git push failed: ${(push.stdout + push.stderr).slice(-500)}`);
  return { sha, url: `https://github.com/${opts.fullName}/commit/${sha}` };
};
