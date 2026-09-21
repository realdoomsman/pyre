import { prisma } from "@pyre/db";
import { SandboxRunnerLine } from "@pyre/shared";
import type { Sandbox } from "e2b";
import type { Logger } from "pino";
import { env } from "../env.js";
import { publishEvent } from "../lib/publishEvent.js";
import { APP_DIR, RUNNER_DIR, runBackground, waitHandle, writeFile } from "../sandbox/sandbox.js";

export type AgentRunOpts = {
  sbx: Sandbox;
  jobId: string;
  appId: string;
  token: string;
  model: string;
  budgetMicros: bigint;
  maxTurns: number;
  systemAppend: string;
  prompt: string;
  /** Absolute epoch ms after which the agent is killed (hard wall). */
  deadlineAt: number;
  log: Logger;
};

export type AgentOutcome = {
  ok: boolean;
  summary: string;
  totalUsd: number;
  turns: number;
  /** Set when the run was aborted or the runner script errored. */
  error: string | null;
};

const BUDGET_POLL_MS = 10_000;

/** Run the Claude agent inside the sandbox, streaming its JSONL to the feed and policing budget/cancellation. */
export const runAgent = async (o: AgentRunOpts): Promise<AgentOutcome> => {
  await writeFile(o.sbx, `${RUNNER_DIR}/prompt.md`, o.prompt);
  await writeFile(
    o.sbx,
    `${RUNNER_DIR}/options.json`,
    JSON.stringify({
      model: o.model,
      maxBudgetUsd: Number(o.budgetMicros) / 1_000_000,
      maxTurns: o.maxTurns,
      cwd: APP_DIR,
      systemAppend: o.systemAppend,
    }),
  );

  const state: { result: AgentOutcome | null; scriptError: string | null; abortReason: string | null } = {
    result: null,
    scriptError: null,
    abortReason: null,
  };
  let buffer = "";
  const pending: Promise<unknown>[] = [];

  const handleLine = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      o.log.debug({ line: text.slice(0, 200) }, "non-json runner output");
      return;
    }
    const parsed = SandboxRunnerLine.safeParse(json);
    if (!parsed.success) return;
    const line = parsed.data;
    switch (line.kind) {
      case "note":
        pending.push(publishEvent(o.appId, { type: "AGENT_NOTE", text: line.text }, o.jobId));
        break;
      case "tool":
        pending.push(publishEvent(o.appId, { type: "TOOL_CALL", tool: line.name, summary: line.summary }, o.jobId));
        break;
      case "cost":
        break;
      case "result":
        state.result = { ok: line.ok, summary: line.summary, totalUsd: line.totalUsd, turns: line.turns, error: null };
        break;
      case "error":
        state.scriptError = line.message;
        break;
    }
  };

  const stderrTail: string[] = [];
  const handle = await runBackground(o.sbx, `node ${RUNNER_DIR}/pyre-runner.mjs`, {
    cwd: RUNNER_DIR,
    timeoutMs: 0,
    envs: {
      ANTHROPIC_BASE_URL: `${env.API_ORIGIN}/v1/proxy/anthropic`,
      ANTHROPIC_API_KEY: o.token,
      HOME: "/home/user",
      CI: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      PLAYWRIGHT_JSON_OUTPUT_NAME: "test-results.json",
    },
    onStdout: (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) handleLine(l);
    },
    onStderr: (chunk) => {
      stderrTail.push(chunk);
      if (stderrTail.length > 50) stderrTail.shift();
    },
  });

  let lastSpent = 0n;
  const poll = setInterval(() => {
    void (async () => {
      const [tok, job] = await Promise.all([
        prisma.jobToken.findUnique({ where: { token: o.token } }),
        prisma.buildJob.findUnique({ where: { id: o.jobId }, select: { status: true } }),
      ]);
      if (!tok || tok.revoked || job?.status === "CANCELLED") {
        state.abortReason = state.abortReason ?? "job cancelled";
      } else if (Date.now() > o.deadlineAt) {
        state.abortReason = state.abortReason ?? "hard wall: 40 minute sandbox limit reached";
      } else if (tok.spentMicros !== lastSpent) {
        const delta = tok.spentMicros - lastSpent;
        lastSpent = tok.spentMicros;
        const remaining = o.budgetMicros > tok.spentMicros ? o.budgetMicros - tok.spentMicros : 0n;
        pending.push(
          publishEvent(
            o.appId,
            {
              type: "BUDGET",
              budgetUsd: Number(remaining) / 1_000_000,
              delta: -Number(delta) / 1_000_000,
              reason: "agent usage",
            },
            o.jobId,
          ),
        );
        if (remaining === 0n) state.abortReason = state.abortReason ?? "job budget exhausted";
      }
      if (state.abortReason) {
        clearInterval(poll);
        await handle.kill().catch(() => undefined);
      }
    })().catch((e) => o.log.warn({ err: e }, "budget poll failed"));
  }, BUDGET_POLL_MS);

  let exit;
  try {
    exit = await waitHandle(handle);
  } finally {
    clearInterval(poll);
  }
  if (buffer.trim()) handleLine(buffer);
  await Promise.allSettled(pending);

  const outcome = state.result;
  if (state.abortReason) {
    return {
      ok: false,
      summary: outcome?.summary ?? "",
      totalUsd: outcome?.totalUsd ?? 0,
      turns: outcome?.turns ?? 0,
      error: state.abortReason,
    };
  }
  if (outcome) {
    return outcome.ok ? outcome : { ...outcome, error: outcome.summary || "agent did not finish successfully" };
  }
  const err =
    state.scriptError ?? `runner script exited with code ${exit.exitCode}: ${stderrTail.join("").slice(-1500)}`;
  return { ok: false, summary: "", totalUsd: 0, turns: 0, error: err };
};
