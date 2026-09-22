import type { AppSpec } from "@pyre/shared";

export type AgentStage = "MVP" | "ITERATE" | "SELF_HEAL";

export const MANIFEST_RULES = `## Pyre platform rules (non-negotiable)
- The app is a Vite + React static site served by the Pyre host. Build output is \`dist/\`; server logic lives in \`functions/<name>.js\` (each exports \`default async function handler(input, ship)\`) and runs in the platform's sandboxed runtime, not in the browser.
- \`pyre.manifest.json\` MUST stay accurate: every function you add under \`functions/\` is listed in \`functions\` (name, auth, holderOnly); set \`holderTier\` when \`<HolderGate>\` is used. The manifest is validated at deploy time — an invalid manifest fails the build.
- NEVER implement auth or token checks yourself, and never add payments of any kind (the app is free to use). Use \`@pyre/app-sdk\` (\`ship.login()\`, \`ship.me()\`, \`ship.kv\`, \`ship.fn(name, input)\`, \`ship.holder()\`, \`<PyreProvider>\`, \`<HolderGate>\`, \`<LoginButton/>\`).
- NEVER use \`fetch\`, \`XMLHttpRequest\`, \`WebSocket\`, external \`<script src>\`, \`eval\`, or any third-party network call in browser code. All server communication goes through \`ship.fn\`. Inside functions, network access is only \`ship.fetch\` to other Pyre apps.
- NEVER touch private keys, sign transactions, or store secrets in localStorage.
- Keep \`tests/smoke.spec.ts\` (Playwright) passing: it loads \`/\` and asserts the main heading. Add tests for new core flows.
- Before finishing: run \`npm run build\` and \`npm test\` and fix everything they report. Do not leave the tree in a broken state.
- Do not modify \`package.json\` dependencies unless strictly necessary; never add packages that reach the network.
- Work autonomously; there is no human to answer questions. Make reasonable product decisions and proceed.`;

export const DESIGN_RULES = `## Pyre design system (mandatory)
- The template ships the Pyre design system: CSS variables in \`src/index.css\` and base components in \`src/components/\` (\`Button\`, \`Card\`, \`Input\`, \`Chip\`, \`EmptyState\`, \`PageHeader\`). Use them and the tokens for every surface; do not restyle them and do not introduce a second palette.
- One dark theme only: obsidian \`#0A0A0C\` page (\`--pyre-bg\`), cards \`#111114\` (\`--pyre-surface\`) with 1px \`#1F1F24\` borders (\`--pyre-border\`) and 8px radius (\`--pyre-radius\`), ink \`#F3F2EE\` text (\`--pyre-ink\`), tempered violet \`#9D8CFF\` accent (\`--pyre-violet\`, hover \`#7A66F5\`). Heat ramp for charts/progress only: \`#1C1B2E → #3B2F7A → #7A66F5 → #3E8BFF → #9CD2FF → #E9F1FF\` (\`--pyre-heat-1…6\`).
- Type: Instrument Serif for display headings (\`font-display\`), Geist for body (\`font-sans\`), Geist Mono for numbers and code (\`font-mono\`, \`tabular-nums\`). Fonts are already wired in \`index.html\` / \`index.css\`.
- Buttons: violet background with ink text (\`<Button>\`); secondary/ghost variants exist. Never white, orange, lime, emerald or gradient buttons.
- FORBIDDEN: orange, lime, emerald or any warm accent; emoji; flame/fire glyphs; light mode; rounded-2xl/pill cards; Tailwind's default palette colours outside neutral greys. The reviewer rejects diffs that violate this section.`;

export const systemContext = (spec: AppSpec, manifestJson: string): string =>
  `# Pyre build agent
You are building a real web app for the Pyre launchpad. The coin's trading fees fund this build; the app is free for its users. Be efficient with turns and tokens.

## Product spec (JSON)
${JSON.stringify(spec, null, 2)}

## Current pyre.manifest.json
${manifestJson}

${MANIFEST_RULES}

${DESIGN_RULES}`;

const list = (items: string[]) => items.map((t, i) => `${i + 1}. ${t}`).join("\n");

export const stagePrompt = (
  stage: AgentStage,
  spec: AppSpec,
  extra: { tasks?: string[]; instruction?: string },
): string => {
  switch (stage) {
    case "MVP":
      return `Build the MVP of "${spec.title}" — ${spec.oneLiner}

What it does: ${spec.whatItDoes}
Holder tier: ${spec.holderTier.enabled ? `enabled (min hold ${spec.holderTier.minHoldTokens ?? 0}); perks: ${spec.holderTier.perks.join(", ") || "none"}` : "disabled"}

## MVP scope (build all of these)
${list(spec.mvp)}

## Out of scope (do NOT build)
${list(spec.outOfScope) || "(nothing listed)"}
${extra.instruction ? `\n## Notes from the previous attempt\n${extra.instruction}\n` : ""}
## Deliverables
- Replace the template starter UI in \`src/\` with the real product, built from the template's Pyre design tokens and base components. Polished, responsive, Tailwind v4, no filler copy.
- Ship production quality, not a demo: the UI MUST be fully responsive (usable down to 375px wide), keyboard-accessible (semantic HTML, labelled controls, visible focus, sensible \`aria-*\` only where needed), and legible with adequate contrast.
- Handle every async action's loading, empty, and error states explicitly — show progress, a friendly recoverable message on failure, and never leave a blank screen or an unhandled promise rejection.
- Put any server-side logic (persistence via \`ship.kv\`, LLM calls via \`ship.llm\`) in \`functions/*.js\` and wire them through \`ship.fn\`.
- Wire holder perks with \`<HolderGate>\` exactly as specified; there are no products, ads or priced functions.
- Keep \`pyre.manifest.json\` accurate (name, functions, holderTier).
- Update \`tests/smoke.spec.ts\` for the new heading and add a Playwright test for the primary user flow.
- Run \`npm run build\` and \`npm test\`; both must pass before you finish.
Finish with a short summary of what was built.`;
    case "ITERATE":
      return `Iterate on "${spec.title}". Token holders voted for the following tasks; implement them in order, fully, without breaking existing behaviour:

${list(extra.tasks ?? [])}
${extra.instruction ? `\nAdditional guidance:\n${extra.instruction}\n` : ""}
Keep \`pyre.manifest.json\` accurate, keep tests green (\`npm run build\` and \`npm test\` must pass), and add tests for new flows. Preserve the app's responsiveness, keyboard accessibility, loading/empty/error handling and the Pyre design system as you change it — do not regress mobile layout, leave new async paths without error states, or introduce off-palette colours. Finish with a short summary of what changed.`;
    case "SELF_HEAL":
      return `The live deployment of "${spec.title}" is unhealthy. Observed error:

\`\`\`
${extra.instruction ?? "unknown error"}
\`\`\`

Find and fix the root cause (not the symptom). Reproduce with \`npm run build\` / \`npm test\` where possible, then make sure both pass. Do not add features. Finish with a short summary of the fix.`;
  }
};
