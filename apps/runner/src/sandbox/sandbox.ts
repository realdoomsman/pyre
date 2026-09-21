import { CommandExitError, Sandbox, type CommandHandle } from "e2b";
import { E2B_TEMPLATE_DEFAULT, env } from "../env.js";

export type CmdResult = { exitCode: number; stdout: string; stderr: string };

export type RunOpts = {
  cwd?: string;
  envs?: Record<string, string>;
  /** 0 = no limit. Defaults to 10 minutes; e2b's own default is only 60s. */
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export const HOME = "/home/user";
export const APP_DIR = `${HOME}/app`;
export const SDK_DIR = `${HOME}/app-sdk`;
export const RUNNER_DIR = `${HOME}/runner`;
export const TEMPLATE_DIR = `${HOME}/template`;

/**
 * Environment applied to every command in a sandbox, installed by
 * `bootstrapSandbox` once it has measured the VM. E2B's `base` template is a
 * 478 MB VM, so V8 sizes its default old-space at ~259 MB and npm dies parsing
 * registry metadata; git must also never reach for a credential prompt. Keyed
 * by sandbox id so a process driving several sandboxes cannot cross-talk.
 */
const defaultEnvs = new Map<string, Record<string, string>>();

export const setSandboxEnvs = (sbx: Sandbox, envs: Record<string, string>): void => {
  defaultEnvs.set(sbx.sandboxId, envs);
};

export const createSandbox = (timeoutMs: number, metadata: Record<string, string>): Promise<Sandbox> =>
  Sandbox.create(env.E2B_TEMPLATE ?? E2B_TEMPLATE_DEFAULT, { apiKey: env.E2B_API_KEY, timeoutMs, metadata });

/** Run a foreground command; non-zero exit is returned, not thrown. */
export const run = async (sbx: Sandbox, cmd: string, opts: RunOpts = {}): Promise<CmdResult> => {
  try {
    const r = await sbx.commands.run(cmd, {
      cwd: opts.cwd,
      envs: { ...defaultEnvs.get(sbx.sandboxId), ...opts.envs },
      timeoutMs: opts.timeoutMs ?? 600_000,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    if (e instanceof CommandExitError) return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr };
    throw e;
  }
};

/** Start a background command; caller waits/kills via the handle. */
export const runBackground = (sbx: Sandbox, cmd: string, opts: RunOpts = {}): Promise<CommandHandle> =>
  sbx.commands.run(cmd, {
    background: true,
    cwd: opts.cwd,
    envs: { ...defaultEnvs.get(sbx.sandboxId), ...opts.envs },
    timeoutMs: opts.timeoutMs ?? 0,
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
  });

/** Wait for a background command; non-zero exit is returned, not thrown. */
export const waitHandle = async (handle: CommandHandle): Promise<CmdResult> => {
  try {
    const r = await handle.wait();
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    if (e instanceof CommandExitError) return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr };
    throw e;
  }
};

export const writeFile = async (sbx: Sandbox, path: string, data: string | Buffer): Promise<void> => {
  const body = typeof data === "string" ? data : new Blob([new Uint8Array(data)]);
  await sbx.files.write(path, body);
};

export const readBytes = async (sbx: Sandbox, path: string): Promise<Uint8Array<ArrayBuffer>> => {
  // e2b builds this from `response.arrayBuffer()`, so it is always ArrayBuffer-backed; its typing is just the generic default.
  const bytes: Uint8Array<ArrayBuffer> = (await sbx.files.read(path, { format: "bytes" })) as Uint8Array<ArrayBuffer>;
  return bytes;
};

export const readText = (sbx: Sandbox, path: string): Promise<string> => sbx.files.read(path, { format: "text" });

export const fileExists = async (sbx: Sandbox, path: string): Promise<boolean> =>
  (await run(sbx, `test -e ${JSON.stringify(path)}`, { timeoutMs: 10_000 })).exitCode === 0;
