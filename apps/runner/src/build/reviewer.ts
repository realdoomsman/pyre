import type { AppSpec } from "@pyre/shared";
import { z } from "zod";
import { models } from "../env.js";
import { askJson } from "../lib/anthropic.js";

export const ReviewVerdict = z.object({
  verdict: z.enum(["APPROVE", "REJECT"]),
  summary: z.string().max(600),
  findings: z.array(z.object({ severity: z.enum(["INFO", "WARN", "BLOCK"]), text: z.string().max(400) })).max(20),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export type ReviewInput = {
  diff: string;
  files: string[];
  manifest: string;
  spec: AppSpec;
};

export type ReviewResult = { verdict: ReviewVerdict; costMicros: bigint; model: string };

const DIFF_CAP = 60_000;

/** Patterns that are never acceptable in app code (the SDK itself is not part of the diff). */
const HARD_BLOCKS: Record<string, RegExp> = {
  "direct fetch()": /(?<!ship\.)\bfetch\s*\(/,
  XMLHttpRequest: /\bXMLHttpRequest\b/,
  WebSocket: /\bnew\s+WebSocket\b|\bWebSocket\s*\(/,
  // Only an off-origin script is a policy breach. A local module script
  // (`<script src="/src/main.tsx">`) is how every Vite app boots, and matching
  // it rejected the template's own index.html on every build.
  "external <script src>": /<script[^>]*\ssrc\s*=\s*["']?(?:[a-z]+:)?\/\//i,
  privateKey: /\bprivateKey\b/,
  secretKey: /\bsecretKey\b/,
  privateKeyToAccount: /\bprivateKeyToAccount\b/,
  sendTransaction: /\bsendTransaction\b|\beth_sendTransaction\b/,
  signTransaction: /\bsignTransaction\b/,
  signTypedData: /\bsignTypedData(?:_v4)?\b|\beth_signTypedData(?:_v4)?\b/,
  "window.ethereum": /\bwindow\.ethereum\b|\bethereum\.request\s*\(/,
  "eval()": /\beval\s*\(/,
};

/**
 * Hard blocks only apply to code that actually ships: the browser bundle
 * (`src/`, `index.html`, `public/`) and the server functions that run in the
 * QuickJS sandbox (`functions/`). Everything else in the repo — the eslint
 * config that BANS these very identifiers, `CLAUDE.md` which documents them,
 * Playwright tests, and local dev tooling — is never served to a user, and
 * scanning it made every build fail on its own policy files. The LLM reviewer
 * still reads the whole diff; only the mechanical blocker is scoped.
 */
const isShippingFile = (file: string): boolean => {
  if (file.includes("app-sdk/") || file.includes("node_modules/") || file.endsWith("package-lock.json")) return false;
  if (file.startsWith("tests/") || file.startsWith("dev/")) return false;
  if (file.endsWith(".md") || /(^|\/)eslint\.config\.[cm]?[jt]s$/.test(file)) return false;
  if (/(^|\/)(playwright|vite|vitest)\.config\.[cm]?[jt]s$/.test(file)) return false;
  return (
    file.startsWith("src/") ||
    file.startsWith("functions/") ||
    file.startsWith("public/") ||
    file === "index.html" ||
    file.endsWith(".html")
  );
};

/** Added lines of a unified diff, keyed by file, limited to files that ship. */
const addedLinesByFile = (diff: string): Array<{ file: string; line: string }> => {
  const out: Array<{ file: string; line: string }> = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (!isShippingFile(file)) continue;
      out.push({ file, line: raw.slice(1) });
    }
  }
  return out;
};

export const hardBlockFindings = (diff: string): ReviewVerdict["findings"] => {
  const findings: ReviewVerdict["findings"] = [];
  const seen: Record<string, true> = {};
  for (const { file, line } of addedLinesByFile(diff)) {
    for (const [label, re] of Object.entries(HARD_BLOCKS)) {
      if (!re.test(line)) continue;
      const key = `${label}:${file}`;
      if (seen[key]) continue;
      seen[key] = true;
      findings.push({ severity: "BLOCK", text: `${label} in ${file}: ${line.trim().slice(0, 160)}` });
    }
  }
  return findings;
};

const REVIEW_SYSTEM = `You are the release reviewer for Pyre, a launchpad on Robinhood Chain where a coin's creator fees pay an AI agent to build the coin's app (free to use) and a share of every coin's fees buys and burns PYRE. You decide whether a code change may be deployed to the app's public origin.

REJECT (with BLOCK findings) when the change:
- implements its own auth, wallet, key handling, transaction signing or on-chain calls instead of using @pyre/app-sdk, or adds any payment, price, paywall or ad (apps are free; the app never touches ETH, USDG, a signer or window.ethereum)
- loads external scripts, or uses fetch/XMLHttpRequest/WebSocket/eval in browser code (server functions may only use ship.fetch)
- exfiltrates data, obfuscates code, mines, or contacts third-party services
- violates the content policy: scams, phishing, impersonation of brands/people, gambling with real money, illegal goods/services, adult content, hate or harassment, malware
- breaks the Pyre design system: light theme, orange/lime/emerald or any warm accent, emoji or flame glyphs, off-palette Tailwind colours, restyled base components
- clearly does not match the product spec, or leaves pyre.manifest.json inconsistent with the code (functions missing or mismatched, holderTier not matching <HolderGate> use)
- deletes or disables the smoke test instead of fixing it

APPROVE otherwise. Style nits and minor bugs are WARN/INFO, not blockers. Be decisive and concise.`;

/** Review a diff: cheap regex hard-blocks first, then the reviewer model. */
export const reviewChange = async (input: ReviewInput): Promise<ReviewResult> => {
  const model = models.REVIEWER;
  const blocks = hardBlockFindings(input.diff);
  if (blocks.length > 0) {
    return {
      model,
      costMicros: 0n,
      verdict: {
        verdict: "REJECT",
        summary: `Blocked by platform policy: ${blocks.map((b) => b.text.split(" in ")[0]).join(", ")}.`,
        findings: blocks,
      },
    };
  }
  const diff = input.diff.length > DIFF_CAP ? `${input.diff.slice(0, DIFF_CAP)}\n[... diff truncated at ${DIFF_CAP} chars ...]` : input.diff;
  const user = `## Product spec
${JSON.stringify(input.spec, null, 2)}

## pyre.manifest.json (after change)
${input.manifest}

## Files in repo
${input.files.slice(0, 400).join("\n")}

## Diff
${diff || "(empty diff)"}`;
  const res = await askJson({
    model,
    system: REVIEW_SYSTEM,
    user,
    schema: ReviewVerdict,
    maxTokens: 2048,
    toolName: "submit_review",
    toolDescription: "Submit the review verdict with findings.",
  });
  const hasBlock = res.value.findings.some((f) => f.severity === "BLOCK");
  return {
    model,
    costMicros: res.costMicros,
    verdict: { ...res.value, verdict: hasBlock ? "REJECT" : res.value.verdict },
  };
};
