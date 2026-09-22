import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@pyre/db";
import { GLOBAL_DAILY_COMPUTE_CEILING_USD, MODELS } from "@pyre/shared";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { costMicrosFor, type Usage } from "../lib/pricing.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const MODEL = MODELS.CLASSIFIER;
const MAX_PROMPT_CHARS = 12_000;
const MAX_TOKENS_CAP = 1024;
const DEFAULT_MAX_TOKENS = 512;
/** Rough chars-per-token for the pre-flight estimate; the debit afterwards uses reported usage. */
const CHARS_PER_TOKEN = 3.5;
const DAILY_CEILING_MICROS = BigInt(GLOBAL_DAILY_COMPUTE_CEILING_USD) * 1_000_000n;

const usd = (micros: bigint): string => `$${(Number(micros) / 1e6).toFixed(4)}`;

/**
 * `ship.llm(prompt, { maxTokens })` inside a function sandbox. Charged to the app's build budget at
 * cost: refused when the budget cannot cover the worst case, debited with the real usage afterwards.
 */
export async function appLlm(appId: string, prompt: string, maxTokens = DEFAULT_MAX_TOKENS): Promise<string> {
  if (prompt.length === 0) throw new Error("ship.llm: prompt is empty");
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`ship.llm: prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  const capped = Math.min(Math.max(Math.trunc(maxTokens), 1), MAX_TOKENS_CAP);

  const day = new Date().toISOString().slice(0, 10);
  const [app, spend] = await Promise.all([
    prisma.app.findUnique({ where: { id: appId }, select: { budgetMicros: true } }),
    prisma.dailyComputeSpend.findUnique({ where: { day }, select: { micros: true } }),
  ]);
  if (!app) throw new Error("ship.llm: app not found");
  if ((spend?.micros ?? 0n) >= DAILY_CEILING_MICROS) throw new Error("ship.llm: platform daily compute ceiling reached");

  const worstCase = costMicrosFor(MODEL, {
    inputTokens: Math.ceil(prompt.length / CHARS_PER_TOKEN),
    outputTokens: capped,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
  if (app.budgetMicros < worstCase) {
    throw new Error(`ship.llm: app budget ${usd(app.budgetMicros)} is below the ${usd(worstCase)} needed for this call`);
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: capped,
    messages: [{ role: "user", content: prompt }],
  });
  const usage: Usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
  };
  const cost = costMicrosFor(response.model || MODEL, usage);
  if (cost > 0n) {
    try {
      await prisma.$transaction([
        prisma.app.update({
          where: { id: appId },
          data: { budgetMicros: { decrement: cost }, spentMicros: { increment: cost } },
        }),
        // A concurrent call can overshoot the remaining budget; never let it go negative.
        prisma.app.updateMany({ where: { id: appId, budgetMicros: { lt: 0n } }, data: { budgetMicros: 0n } }),
        // Same row the build engine writes, so the LEDGER reconcile check sees every debit.
        prisma.ledgerEntry.create({ data: { account: `BUILD:${appId}`, deltaMicros: -cost, refType: "AppLlm", refId: appId, memo: "ship.llm call" } }),
        prisma.dailyComputeSpend.upsert({
          where: { day },
          create: { day, micros: cost },
          update: { micros: { increment: cost } },
        }),
      ]);
    } catch (err) {
      logger.error({ err, appId, costMicros: cost.toString() }, "host: ship.llm budget debit failed");
    }
  }
  let text = "";
  for (const block of response.content) if (block.type === "text") text += block.text;
  return text.trim();
}
