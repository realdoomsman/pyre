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
  const remote = `https://github.com/${opts.fullName}.git`;
  const pushCmd = `git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "$REMOTE" || git remote add origin "$REMOTE"; git -c http.extraheader="$GIT_AUTH" push -q -u origin HEAD:main`;
  const envs = { REMOTE: remote, GIT_AUTH: gitAuthHeader() };
  let push = await run(sbx, pushCmd, { cwd: APP_DIR, timeoutMs: 180_000, envs });
  if (push.exitCode !== 0 && /rejected|fetch first|non-fast-forward/i.test(push.stdout + push.stderr)) {
    // Remote main moved since the clone (an abandoned attempt pushed, or a contributor PR merged).
    // This tree passed verify + review, so it wins every conflict, but remote history is kept so
    // nothing a contributor merged into files we did not touch is lost.
    const merge = await run(
      sbx,
      `git -c http.extraheader="$GIT_AUTH" fetch -q origin main && git -c user.name=pyre -c user.email=agent@pyre.fun merge -q -X ours --allow-unrelated-histories --no-edit -m "merge remote main (build wins conflicts)" origin/main`,
      { cwd: APP_DIR, timeoutMs: 120_000, envs },
    );
    if (merge.exitCode !== 0) throw new Error(`git push rejected and merge failed: ${(merge.stdout + merge.stderr).slice(-500)}`);
    push = await run(sbx, pushCmd, { cwd: APP_DIR, timeoutMs: 180_000, envs });
  }
  if (push.exitCode !== 0) throw new Error(`git push failed: ${(push.stdout + push.stderr).slice(-500)}`);
  const head = await run(sbx, "git rev-parse HEAD", { cwd: APP_DIR, timeoutMs: 10_000 });
  const sha = head.stdout.trim();
  if (!sha) throw new Error("git rev-parse HEAD produced no sha");
  return { sha, url: `https://github.com/${opts.fullName}/commit/${sha}` };
};
