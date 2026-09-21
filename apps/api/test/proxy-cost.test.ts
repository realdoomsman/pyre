import { describe, expect, it, vi } from "vitest";

/**
 * Agent spend accounting. Every dollar of build budget is debited from what this table says a
 * call cost, so an error here either bankrupts an app or lets it burn platform money forever.
 * The proxy module is imported for its pure usage helpers only; prisma is faked so nothing can
 * reach a database.
 */

vi.mock("@pyre/db", () => ({
  prisma: {
    $transaction: async () => [],
    jobToken: { update: async () => ({}), findUnique: async () => null },
    buildJob: { updateMany: async () => ({ count: 0 }) },
    dailyComputeSpend: { upsert: async () => ({}), findUnique: async () => null },
  },
}));

import { costMicrosFor, type Usage } from "../src/lib/pricing.js";
import { applyUsage, createUsageScanner } from "../src/proxy/anthropic.js";

const usage = (u: Partial<Usage>): Usage => ({
  inputTokens: u.inputTokens ?? 0,
  outputTokens: u.outputTokens ?? 0,
  cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
  cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
});

describe("costMicrosFor", () => {
  it("prices a plain input/output call per model", () => {
    // $/MTok equals micros/token: 1000 input + 500 output on sonnet ($2/$10) = 2000 + 5000 micros.
    expect(costMicrosFor("claude-sonnet-5", usage({ inputTokens: 1000, outputTokens: 500 }))).toBe(7_000n);
    expect(costMicrosFor("claude-opus-5", usage({ inputTokens: 1000, outputTokens: 500 }))).toBe(17_500n);
    expect(costMicrosFor("claude-haiku-4-5", usage({ inputTokens: 1000, outputTokens: 500 }))).toBe(3_500n);
    expect(costMicrosFor("claude-fable-5-1", usage({ inputTokens: 1000, outputTokens: 500 }))).toBe(35_000n);
  });

  it("charges cache writes at 1.25x input", () => {
    expect(costMicrosFor("claude-sonnet-5", usage({ cacheCreationInputTokens: 1000 }))).toBe(2_500n);
    expect(costMicrosFor("claude-opus-5", usage({ cacheCreationInputTokens: 4000 }))).toBe(25_000n);
  });

  it("charges cache reads at the model's cacheRead multiple of input", () => {
    // 0.1x input for the three production models: a 90% discount on cached prompt prefixes.
    expect(costMicrosFor("claude-sonnet-5", usage({ cacheReadInputTokens: 10_000 }))).toBe(2_000n);
    expect(costMicrosFor("claude-opus-5", usage({ cacheReadInputTokens: 10_000 }))).toBe(5_000n);
    expect(costMicrosFor("claude-haiku-4-5", usage({ cacheReadInputTokens: 10_000 }))).toBe(1_000n);
    // claude-fable-5-1 carries 0.025 instead of 0.1, i.e. a 0.25/MTok cache read. Pinned as-is;
    // if the table is meant to be uniform this row under-charges cache reads by 4x.
    expect(costMicrosFor("claude-fable-5-1", usage({ cacheReadInputTokens: 10_000 }))).toBe(2_500n);
  });

  it("sums all four usage components", () => {
    const full = usage({ inputTokens: 12_345, outputTokens: 6_789, cacheCreationInputTokens: 2_000, cacheReadInputTokens: 40_000 });
    // sonnet: 24690 + 67890 + 5000 (2000*2*1.25) + 8000 (40000*2*0.1)
    expect(costMicrosFor("claude-sonnet-5", full)).toBe(105_580n);
  });

  it("matches on the longest model-name prefix, so dated snapshots price correctly", () => {
    expect(costMicrosFor("claude-sonnet-5-20260101", usage({ inputTokens: 1_000_000 }))).toBe(2_000_000n);
    expect(costMicrosFor("claude-haiku-4-5-20260101", usage({ inputTokens: 1_000_000 }))).toBe(1_000_000n);
    // "claude-fable-5-1" must win over nothing shorter mis-matching it.
    expect(costMicrosFor("claude-fable-5-1-preview", usage({ inputTokens: 1_000_000 }))).toBe(10_000_000n);
  });

  it("bills an unknown model at the most expensive tier so a budget can never be under-charged", () => {
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const unknown = costMicrosFor("claude-something-unreleased", u);
    for (const known of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
      expect(unknown).toBeGreaterThanOrEqual(costMicrosFor(known, u));
    }
    expect(unknown).toBe(costMicrosFor("claude-fable-5-1", u));
    expect(costMicrosFor("", u)).toBe(unknown);
    expect(costMicrosFor("gpt-4o", u)).toBe(unknown);
  });

  it("rounds a fractional cost up, never down to zero", () => {
    // 1 cache-read token on sonnet costs 0.2 micros; charging 0 would make cache reads free.
    expect(costMicrosFor("claude-sonnet-5", usage({ cacheReadInputTokens: 1 }))).toBe(1n);
    expect(costMicrosFor("claude-sonnet-5", usage({ cacheCreationInputTokens: 1 }))).toBe(3n);
    expect(costMicrosFor("claude-sonnet-5", usage({ inputTokens: 0, outputTokens: 0 }))).toBe(0n);
  });

  it("stays exact for a whole build's worth of tokens", () => {
    const heavy = usage({ inputTokens: 50_000_000, outputTokens: 5_000_000, cacheReadInputTokens: 500_000_000 });
    // 250M + 125M + 250M micros = $625 on opus; a float drift here is real money.
    expect(costMicrosFor("claude-opus-5", heavy)).toBe(625_000_000n);
  });
});

describe("applyUsage", () => {
  it("takes the latest cumulative value of each field", () => {
    const u = usage({});
    applyUsage(u, { input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 1 });
    applyUsage(u, { output_tokens: 250 });
    expect(u).toEqual({ inputTokens: 1000, outputTokens: 250, cacheCreationInputTokens: 0, cacheReadInputTokens: 2000 });
  });

  it("does not let a null or absent cache field clobber a value already reported", () => {
    const u = usage({});
    applyUsage(u, { input_tokens: 100, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 7_000 });
    applyUsage(u, { output_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null });
    applyUsage(u, { output_tokens: 20 });
    expect(u).toEqual({ inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 5_000, cacheReadInputTokens: 7_000 });
  });

  it("accepts an explicit zero, which is not the same as absent", () => {
    const u = usage({ inputTokens: 500, outputTokens: 500 });
    applyUsage(u, { output_tokens: 0 });
    expect(u.outputTokens).toBe(0);
    expect(u.inputTokens).toBe(500);
  });
});

describe("streaming usage scanner", () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-20260101","usage":{"input_tokens":12000,"cache_creation_input_tokens":800,"cache_read_input_tokens":40000,"output_tokens":1}}}\n\n',
    "event: ping\ndata: {}\n\n",
    ': keep-alive comment\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":300}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":734,"cache_read_input_tokens":null}}\n\n',
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
  ];
  const expected = usage({ inputTokens: 12_000, outputTokens: 734, cacheCreationInputTokens: 800, cacheReadInputTokens: 40_000 });

  it("accumulates the same total as the equivalent non-streaming response", () => {
    const streamed = usage({});
    const scanner = createUsageScanner(streamed);
    for (const frame of frames) scanner.scan(frame);

    const nonStreaming = usage({});
    applyUsage(nonStreaming, {
      input_tokens: 12_000,
      output_tokens: 734,
      cache_creation_input_tokens: 800,
      cache_read_input_tokens: 40_000,
    });

    expect(streamed).toEqual(expected);
    expect(streamed).toEqual(nonStreaming);
    expect(costMicrosFor(scanner.model ?? "unknown", streamed)).toBe(costMicrosFor("claude-sonnet-5", nonStreaming));
    // 24000 input + 7340 output + 2000 cache write + 8000 cache read
    expect(costMicrosFor("claude-sonnet-5", streamed)).toBe(41_340n);
  });

  it("reads the real model name out of message_start rather than trusting the request", () => {
    const u = usage({});
    const scanner = createUsageScanner(u);
    scanner.scan(frames[0]!);
    expect(scanner.model).toBe("claude-sonnet-5-20260101");
  });

  it("parses frames split across chunk boundaries, including inside the frame separator", () => {
    const whole = frames.join("");
    for (const size of [1, 7, 64, 500]) {
      const u = usage({});
      const scanner = createUsageScanner(u);
      for (let i = 0; i < whole.length; i += size) scanner.scan(whole.slice(i, i + size));
      expect(u).toEqual(expected);
    }
  });

  it("ignores pings, comments, non-JSON data lines and unknown frame types", () => {
    const u = usage({});
    const scanner = createUsageScanner(u);
    scanner.scan("event: ping\ndata: {}\n\n");
    scanner.scan("data: not-json at all\n\n");
    scanner.scan('data: {"type":"unknown_frame","usage":{"output_tokens":999999}}\n\n');
    scanner.scan(": comment only\n\n");
    expect(u).toEqual(usage({}));
    expect(scanner.model).toBeNull();
  });

  it("charges for a stream that is cut off mid-flight using the last usage it saw", () => {
    // An interrupted build must still be billed: silently dropping usage is free compute.
    const u = usage({});
    const scanner = createUsageScanner(u);
    scanner.scan(frames[0]!);
    scanner.scan(frames[4]!);
    scanner.scan('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tok');
    expect(u).toEqual({ inputTokens: 12_000, outputTokens: 300, cacheCreationInputTokens: 800, cacheReadInputTokens: 40_000 });
    expect(costMicrosFor("claude-sonnet-5", u)).toBeGreaterThan(0n);
  });
});
