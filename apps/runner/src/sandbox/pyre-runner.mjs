// Runs inside the E2B sandbox. Drives Claude Code via @anthropic-ai/claude-agent-sdk
// and streams JSONL `SandboxRunnerLine` records on stdout for the runner to relay
// to the build feed. The only credential in the environment is the per-job proxy
// token (ANTHROPIC_API_KEY) pointing at ANTHROPIC_BASE_URL.
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

const RUNNER_DIR = "/home/user/runner";
const emit = (line) => process.stdout.write(JSON.stringify(line) + "\n");
const clip = (s, n = 200) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : s ?? "");

const summarizeTool = (name, input) => {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Bash":
      return clip(input.command);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return clip(input.file_path ?? input.notebook_path);
    case "Glob":
    case "Grep":
      return clip(`${input.pattern ?? ""} ${input.path ?? ""}`.trim());
    case "WebFetch":
      return clip(input.url);
    case "WebSearch":
      return clip(input.query);
    case "Task":
      return clip(input.description ?? input.prompt);
    case "TodoWrite":
      return clip(Array.isArray(input.todos) ? input.todos.map((t) => t.content).join("; ") : "");
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return clip(first ?? JSON.stringify(input));
    }
  }
};

const main = async () => {
  const prompt = readFileSync(`${RUNNER_DIR}/prompt.md`, "utf8");
  const options = JSON.parse(readFileSync(`${RUNNER_DIR}/options.json`, "utf8"));

  const q = query({
    prompt,
    options: {
      model: options.model,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      cwd: options.cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: options.systemAppend ?? "" },
      env: { ...process.env },
      includePartialMessages: false,
    },
  });

  let sawResult = false;
  for await (const msg of q) {
    if (msg.type === "assistant") {
      const content = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
      for (const block of content) {
        if (block.type === "text" && block.text && block.text.trim()) {
          emit({ kind: "note", text: clip(block.text.trim(), 2000) });
        } else if (block.type === "tool_use") {
          emit({ kind: "tool", name: String(block.name ?? "tool"), summary: summarizeTool(block.name, block.input) });
        }
      }
    } else if (msg.type === "result") {
      sawResult = true;
      const ok = msg.subtype === "success";
      emit({
        kind: "result",
        ok,
        totalUsd: Number(msg.total_cost_usd ?? 0),
        summary: clip(ok ? (msg.result ?? "") : `${msg.subtype}${msg.errors ? ": " + msg.errors.join("; ") : ""}`, 4000),
        turns: Number(msg.num_turns ?? 0),
      });
    }
  }
  if (!sawResult) emit({ kind: "error", message: "agent stream ended without a result message" });
};

main().catch((e) => {
  emit({ kind: "error", message: clip(String(e && e.stack ? e.stack : e), 4000) });
  process.exitCode = 1;
});
