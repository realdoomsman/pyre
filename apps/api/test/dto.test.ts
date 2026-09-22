import { describe, expect, it, vi } from "vitest";
import { dec } from "@pyre/db";
import { AppSummaryDto, HolderDto, PyreBurnDto, TradeDto, PONS_TOTAL_SUPPLY } from "@pyre/shared";

/**
 * DTO builders are the API's public contract with the web: every row → JSON mapping here is
 * validated against the shared zod schema, and the derived fields the UI ranks on (heat, agent
 * state, progress pinning, burned %, holder tags) are pinned at their boundaries.
 */

// Real `Prisma.Decimal` rows exercise the Decimal → string boundary (decimal.js would render 1e21+ in exponent form).
vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<object>()), prisma: {} }));
vi.mock("../src/lib/metrics.js", () => ({ db: {} }));
vi.mock("../src/lib/cache.js", () => ({ cached: <T,>(_k: unknown, _t: unknown, fn: () => Promise<T>) => fn() }));
vi.mock("@pyre/chain", () => ({
  getErc20Balance: vi.fn(),
  DEAD_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  ponsAddresses: () => ({
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",
    buybackVault: "0x42df2a798f82289E177311362e8f5ccC45c1219c",
  }),
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: {} }),
}));

import { agentState, appSummary, heatIndex, holderDto, pyreBurnDto, tradeDto, type AppSummaryRow } from "../src/lib/dto.js";

const ETH = 10n ** 18n;
const NOW = new Date("2026-09-21T12:00:00.000Z");
const TOKEN = "0x3333333333333333333333333333333333333333";

const row = (over: Partial<AppSummaryRow> = {}): AppSummaryRow => ({
  id: "app1",
  slug: "cool",
  name: "Cool",
  ticker: "COOL",
  imageUrl: "https://img.test/cool.png",
  status: "LIVE",
  template: "WEB_TOOL",
  spec: {
    title: "Cool",
    oneLiner: "Does the thing",
    whatItDoes: "It does the thing you asked for, reliably, every time.",
    mvp: ["do the thing"],
    holderTier: { enabled: false, minHoldTokens: null },
  },
  tokenAddress: TOKEN,
  curveAddress: "0x4444444444444444444444444444444444444444",
  poolId: null,
  launchPhase: 0,
  progress: 0.42,
  priceUsd: 0.001,
  marketCapUsd: 1000,
  change24hPct: 3.5,
  volume24hUsd: 250,
  holdersCount: 12,
  budgetMicros: 30_000_000n,
  feesWei: dec(ETH / 10n),
  liveVersion: 3,
  createdAt: NOW,
  launchedAt: NOW,
  graduatedAt: null,
  launcher: { id: "u1", displayName: "Ada", avatarUrl: null, wallet: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", xHandle: null },
  jobs: [],
  ...over,
});

const extras = { fees24hWei: ETH / 100n };

describe("appSummary", () => {
  it("produces a valid AppSummaryDto with bigints as strings and derived fields", () => {
    const dto = appSummary(row(), extras, 2000);
    expect(AppSummaryDto.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({
      oneLiner: "Does the thing",
      feesWei: (ETH / 10n).toString(),
      progress: 0.42,
      phase: 0,
      agentState: "idle",
      liveUrl: "https://cool.apps.pyre.test",
      ponsUrl: `https://www.ponsfamily.com/launchpad/${TOKEN}`,
      launchedAt: NOW.toISOString(),
    });
    expect(dto.explorerUrl).toContain(TOKEN);
    expect(dto.heat).toBeGreaterThan(0);
    expect(dto.heat).toBeLessThan(1);
  });

  it("pins progress to 1 once graduated and hides liveUrl before the first deploy", () => {
    const graduated = appSummary(row({ launchPhase: 2, progress: 0.3, graduatedAt: NOW, poolId: "0x" + "11".repeat(32) }), extras, 2000);
    expect(graduated.progress).toBe(1);
    expect(graduated.phase).toBe(2);
    expect(graduated.graduatedAt).toBe(NOW.toISOString());
    const fresh = appSummary(row({ liveVersion: 0 }), extras, 2000);
    expect(fresh.liveUrl).toBeNull();
    const dormant = appSummary(row({ status: "DORMANT" }), extras, 2000);
    expect(dormant.agentState).toBe("dormant");
  });

  it("degrades a missing spec and an unlaunched coin to empty/null fields", () => {
    const dto = appSummary(row({ spec: null, tokenAddress: null, curveAddress: null }), { fees24hWei: 0n }, 2000);
    expect(AppSummaryDto.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({ oneLiner: "", tokenAddress: null, ponsUrl: null, explorerUrl: null, change24hPct: null });
  });
});

describe("agentState", () => {
  it("follows the newest active job's stage, then the app status", () => {
    expect(agentState("LIVE", { stage: "MVP" })).toBe("building");
    expect(agentState("LIVE", { stage: "ITERATE" })).toBe("building");
    expect(agentState("LIVE", { stage: "PR_REVIEW" })).toBe("reviewing");
    expect(agentState("LIVE", { stage: "DEPLOY" })).toBe("deploying");
    expect(agentState("LIVE", { stage: "VERIFY" })).toBe("deploying");
    expect(agentState("DORMANT", null)).toBe("dormant");
    expect(agentState("LIVE", null)).toBe("idle");
  });
});

describe("heatIndex", () => {
  it("is 0 for a cold app, grows with every signal, and never reaches 1", () => {
    const cold = heatIndex({ fees24hWei: 0n, volume24hUsd: 0, ethPriceUsd: 2000 });
    expect(cold).toBe(0);
    // $50 of fees in a day is the "warm" figure: 0.6 weight → 1 − e^(−0.6).
    const warm = heatIndex({ fees24hWei: ETH / 40n, volume24hUsd: 0, ethPriceUsd: 2000 });
    expect(warm).toBeCloseTo(1 - Math.exp(-0.6), 6);
    const withVolume = heatIndex({ fees24hWei: ETH / 40n, volume24hUsd: 2_500, ethPriceUsd: 2000 });
    expect(withVolume).toBeGreaterThan(warm);
    const hot = heatIndex({ fees24hWei: 1000n * ETH, volume24hUsd: 10_000_000, ethPriceUsd: 2000 });
    expect(hot).toBeLessThan(1);
    expect(hot).toBeGreaterThan(0.99);
  });
});

describe("pyreBurnDto", () => {
  it("prefers the on-chain totalSupply delta over the requested burn and dates the row at settlement", () => {
    const dto = pyreBurnDto({
      id: "pb1",
      status: "BURNED",
      usdMicros: 12_000_000n,
      ethWei: dec(ETH / 200n),
      tokensBought: dec(1_000n * ETH),
      tokensBurned: dec(1_000n * ETH),
      burnedUnits: dec(999n * ETH),
      attestHash: "ab".repeat(32),
      swapTx: "0x" + "01".repeat(32),
      burnTx: "0x" + "02".repeat(32),
      attestTx: "0x" + "03".repeat(32),
      error: null,
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
      completedAt: NOW,
    });
    expect(PyreBurnDto.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({ burnedUnits: (999n * ETH).toString(), usdMicros: "12000000", createdAt: NOW.toISOString() });
    expect(dto.burnedPctOfSupply).toBeCloseTo(Number(999n * ETH * 100n * 10_000n / PONS_TOTAL_SUPPLY) / 10_000, 6);
  });
});

describe("tradeDto + holderDto", () => {
  it("maps a fill row and tags protocol-owned holder rows", () => {
    const trade = tradeDto({
      id: "t1",
      appId: "app1",
      txHash: "0x" + "04".repeat(32),
      block: 99n,
      ts: NOW,
      side: "BUY",
      venue: "CURVE",
      wallet: "0x0000000000000000000000000000000000000001",
      tokenUnits: dec(ETH),
      quoteWei: dec(ETH / 1000n),
      priceUsd: 0.002,
      createdAt: NOW,
    });
    expect(TradeDto.parse(trade)).toEqual(trade);
    expect(trade.block).toBe(99);

    const ctx = { curveAddress: "0x4444444444444444444444444444444444444444", launcherWallet: "0x84F8E5a324466Deb7447048C014CF0245ce04afA" };
    const tags = [
      ["0x4444444444444444444444444444444444444444", "curve"],
      ["0x8366a39CC670B4001A1121B8F6A443A643e40951", "pool"],
      ["0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952", "locker"],
      ["0x42df2a798f82289E177311362e8f5ccC45c1219c", "vault"],
      ["0x000000000000000000000000000000000000dEaD", "dead"],
      ["0x0000000000000000000000000000000000000001", "treasury"],
      ["0x84F8E5a324466Deb7447048C014CF0245ce04afA", "launcher"],
      ["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", null],
    ] as const;
    for (const [wallet, tag] of tags) {
      const h = holderDto({ wallet, amount: PONS_TOTAL_SUPPLY / 50n }, ctx);
      expect(HolderDto.parse(h)).toEqual(h);
      expect(h.tag).toBe(tag);
      expect(h.pct).toBe(2);
    }
  });
});
