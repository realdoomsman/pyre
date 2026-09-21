import Anthropic from "@anthropic-ai/sdk";
import { z, type ZodType, type ZodTypeAny } from "zod";
import { env } from "../env.js";
import { log } from "./logger.js";
import { costMicrosFor, type TokenUsage } from "./pricing.js";

/** Runner-side client with the real key. Never handed to a sandbox. */
export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });

export type AskJsonResult<T> = { value: T; usage: TokenUsage; costMicros: bigint };

/** Zod schema → JSON schema for a tool definition (objects, arrays, enums, primitives, nullable). */
export const zodToToolSchema = (schema: ZodTypeAny): Record<string, unknown> => {
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, ZodTypeAny> = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodToToolSchema(v);
      if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) required.push(k);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  if (schema instanceof z.ZodArray) return { type: "array", items: zodToToolSchema(schema.element) };
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodNullable) return { anyOf: [zodToToolSchema(schema.unwrap()), { type: "null" }] };
  if (schema instanceof z.ZodOptional) return zodToToolSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToToolSchema(schema.removeDefault());
  if (schema instanceof z.ZodEffects) return zodToToolSchema(schema.innerType());
  return {};
};

/**
 * Ask a model for a structured object via forced tool-use, validate with zod,
 * retry once with the validation error appended. Returns usage + cost so the
 * caller can account it.
 */
export const askJson = async <T>(opts: {
  model: string;
  system: string;
  user: string;
  schema: ZodType<T>;
  maxTokens: number;
  toolName: string;
  toolDescription?: string;
}): Promise<AskJsonResult<T>> => {
  const usage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const inputSchema = zodToToolSchema(opts.schema);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0 ? opts.user : `${opts.user}\n\nYour previous answer was invalid: ${lastError}\nAnswer again, strictly matching the schema.`;
    const res = await anthropic.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: user }],
      tools: [
        {
          name: opts.toolName,
          description: opts.toolDescription ?? "Submit the structured answer.",
          input_schema: inputSchema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: opts.toolName },
    });
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    usage.cache_creation_input_tokens =
      (usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0);

    const toolUse = res.content.find((c) => c.type === "tool_use");
    const raw = toolUse && toolUse.type === "tool_use" ? toolUse.input : undefined;
    const parsed = opts.schema.safeParse(raw);
    if (parsed.success) {
      return { value: parsed.data, usage, costMicros: costMicrosFor(opts.model, usage) };
    }
    lastError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    log.warn({ model: opts.model, tool: opts.toolName, attempt, lastError }, "structured answer failed validation");
  }
  throw new Error(`Model ${opts.model} returned invalid ${opts.toolName}: ${lastError}`);
};
