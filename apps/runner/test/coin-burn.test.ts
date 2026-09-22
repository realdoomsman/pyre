import type * as Db from "@pyre/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coin burns on Solana mirror the $PYRE machine: the COINBURN:<appId> ledger is debited the moment
 * a row opens (never twice), a buy happens only after the CAS to SWAPPING, a row found SWAPPING is
 * never re-bought, and a SWAPPED row resumes at the burn. The adapter and prisma are faked; no I/O.
 */

interface Row {
  id: string;
  appId: string;
  status: string;
  usdMicros: bigint;
  nativeWei: bigint;
  tokensBought: bigint;
  tokensBurned: bigint;
  burnedUnits: bigint | null;
  attestHash: string;
  swapTx: string | null;
  burnTx: string | null;
  attestTx: string | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

const fx = vi.hoisted(() => {
  const rows: Row[] = [];
  const ledger: Array<{ id: string; account: string; deltaMicros: bigint; refType: string; refId: string; createdAt: Date }> = [];
  let seq = 0;
  const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));
  const coinBurn = {
    findFirst: vi.fn(async ({ where }: { where: { appId: string; status: string } }) => rows.find((r) => r.appId === where.appId && r.status === where.status) ?? null),
    create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
      const row: Row = { id: `cb${++seq}`, status: "PENDING", tokensBought: 0n, tokensBurned: 0n, burnedUnits: null, swapTx: null, burnTx: null, attestTx: null, error: null, createdAt: new Date(), completedAt: null, ...(data as Row) };
      row.nativeWei = big(row.nativeWei);
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id)!;
      for (const [k, v] of Object.entries(data)) (row as unknown as Record<string, unknown>)[k] = ["nativeWei", "tokensBought", "tokensBurned", "burnedUnits"].includes(k) ? big(v) : v;
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: { status: string } }) => {
      const row = rows.find((r) => r.id === where.id && r.status === where.status);
      if (!row) return { count: 0 };
      row.status = data.status;
      return { count: 1 };
    }),
  };
  const ledgerEntry = {
    aggregate: vi.fn(async ({ where }: { where: { account: string } }) => ({ _sum: { deltaMicros: ledger.filter((e) => e.account === where.account).reduce((a, e) => a + e.deltaMicros, 0n) } })),
    findFirst: vi.fn(async ({ where }: { where: { account: string; refType: string } }) => ledger.filter((e) => e.account === where.account && e.refType === where.refType).at(-1) ?? null),
    findMany: vi.fn(async ({ where }: { where: { account: string } }) => ledger.filter((e) => e.account === where.account && e.deltaMicros > 0n)),
    create: vi.fn(async ({ data }: { data: Omit<(typeof ledger)[number], "id" | "createdAt"> }) => {
      const row = { id: `led${++seq}`, createdAt: new Date(), ...data };
      ledger.push(row);
      return row;
    }),
  };
  return { rows, ledger, coinBurn, ledgerEntry, prisma: { coinBurn, ledgerEntry, $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({ coinBurn, ledgerEntry }) } };
});

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma: fx.prisma }));
vi.mock("@pyre/chain", () => ({
  attestationHash: (ids: string[]) => "ab".repeat(16) + ids.length.toString(16).padStart(32, "0"),
  solanaEnabled: () => true,
  adapterFor: () => {
    throw new Error("adapter is injected");
  },
}));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn() }));
vi.mock("../src/workers/chain/buyback.js", () => ({ MIN_BUYBACK_MICROS: 5_000_000n }));

const { runCoinBurn } = await import("../src/workers/chain/coinBurn.js");

const MINT = "7LSsdY1uSQ2eR1vUSp7cw2jxBkm4bkkPrzHhrFeNpump";
const TREASURY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const APP = { id: "app1", chain: "solana" as const, launchpad: "pump_fun" as const, tokenAddress: MINT, slug: "solcool" };
const SOL = 10n ** 9n;
const UNIT = 10n ** 6n;
const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const adapter = (over: Record<string, unknown> = {}) => {
  const state = { supply: 10n ** 15n, held: 0n, phase: 0 as 0 | 1 | 2 };
  const a = {
    info: { chain: "solana", launchpad: "pump_fun", native: { symbol: "SOL", decimals: 9 }, tokenDecimals: 6 },
    treasury: () => ({ chain: "solana", address: TREASURY, signer: {} }),
    nativePriceUsd: async () => 100,
    nativeBalance: vi.fn(async () => 5n * SOL),
    readLaunch: vi.fn(async () => ({ exists: true, token: MINT, curve: "c", pool: null, phase: state.phase, progress: 0.1, raisedNative: 0n, graduationNative: 85n * SOL, priceNative: 1e-7, totalSupplyUnits: state.supply, circulatingUnits: 0n, burnedUnits: 10n ** 15n - state.supply })),
    quoteBuy: vi.fn(async (_t: string, spend: bigint) => ({ native: spend, tokenUnits: spend * 10n, priceNative: 1e-7, feeBps: 125, impact: 0.01 })),
    buy: vi.fn(async (_acc: unknown, _t: string, spend: bigint) => {
      state.held += spend * 10n;
      return { hash: "swapSig", block: 1, tokenUnits: spend * 10n, spentNative: spend };
    }),
    tokenBalance: vi.fn(async () => state.held),
    burn: vi.fn(async (_acc: unknown, _t: string, units: bigint) => {
      state.held -= units;
      state.supply -= units;
      return { hash: "burnSig", block: 2, burnedUnits: units };
    }),
    attest: vi.fn(async () => ({ hash: "memoSig", block: 3 })),
    state,
    ...over,
  };
  return a;
};

beforeEach(() => {
  fx.rows.length = 0;
  fx.ledger.length = 0;
  vi.clearAllMocks();
});

const credit = (micros: bigint) => fx.ledger.push({ id: `fee${fx.ledger.length}`, account: "COINBURN:app1", deltaMicros: micros, refType: "FeeEvent", refId: "fee", createdAt: new Date() });

describe("coin burn state machine", () => {
  it("does nothing below $5 pending", async () => {
    credit(4_990_000n);
    const a = adapter();
    await runCoinBurn(APP, log as never, a as never);
    expect(fx.rows).toHaveLength(0);
    expect(a.buy).not.toHaveBeenCalled();
  });

  it("opens the row for the whole balance, debits COINBURN once, buys from the treasury Solana wallet, burns exactly what was bought and attests", async () => {
    credit(3_000_000n);
    credit(4_000_000n);
    const a = adapter();
    await runCoinBurn(APP, log as never, a as never);

    const row = fx.rows[0]!;
    expect(row).toMatchObject({ status: "BURNED", usdMicros: 7_000_000n, swapTx: "swapSig", burnTx: "burnSig", attestTx: "memoSig" });
    // $7 at $100/SOL = 0.07 SOL
    expect(row.nativeWei).toBe(70_000_000n);
    expect(row.tokensBought).toBe(700_000_000n);
    expect(row.tokensBurned).toBe(700_000_000n);
    expect(row.burnedUnits).toBe(700_000_000n);
    expect(fx.ledger.filter((e) => e.refType === "CoinBurn")).toEqual([expect.objectContaining({ account: "COINBURN:app1", deltaMicros: -7_000_000n, refId: row.id })]);
    const [account, mint, spend, minOut] = a.buy.mock.calls[0]!;
    expect(account).toMatchObject({ address: TREASURY });
    expect(mint).toBe(MINT);
    expect(spend).toBe(70_000_000n);
    expect(minOut).toBe((700_000_000n * 9900n) / 10_000n);
    expect(a.burn).toHaveBeenCalledWith(expect.objectContaining({ address: TREASURY }), MINT, 700_000_000n);
    expect(a.attest).toHaveBeenCalledWith(expect.objectContaining({ address: TREASURY }), row.attestHash);
    // A second pass with nothing new pending opens nothing and buys nothing.
    await runCoinBurn(APP, log as never, a as never);
    expect(fx.rows).toHaveLength(1);
    expect(a.buy).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed buy in SWAPPING with the error and never re-buys it", async () => {
    credit(10_000_000n);
    const a = adapter({ buy: vi.fn(async () => Promise.reject(new Error("blockhash expired"))) });
    await runCoinBurn(APP, log as never, a as never);
    expect(fx.rows[0]).toMatchObject({ status: "SWAPPING", error: "blockhash expired" });
    await runCoinBurn(APP, log as never, a as never);
    expect(a.buy).toHaveBeenCalledTimes(1);
    expect(fx.rows).toHaveLength(1);
  });

  it("resumes a SWAPPED row at the burn without buying again", async () => {
    const a = adapter();
    a.state.held = 500n * UNIT;
    fx.rows.push({ id: "cb0", appId: "app1", status: "SWAPPED", usdMicros: 5_000_000n, nativeWei: 50_000_000n, tokensBought: 500n * UNIT, tokensBurned: 0n, burnedUnits: null, attestHash: "ab".repeat(32), swapTx: "old", burnTx: null, attestTx: null, error: null, createdAt: new Date(), completedAt: null });
    await runCoinBurn(APP, log as never, a as never);
    expect(a.buy).not.toHaveBeenCalled();
    expect(fx.rows[0]).toMatchObject({ status: "BURNED", burnTx: "burnSig", attestTx: "memoSig", tokensBurned: 500n * UNIT });
  });

  it("defers while the coin is migrating and keeps the treasury floor", async () => {
    credit(10_000_000n);
    const migrating = adapter();
    migrating.state.phase = 1;
    await runCoinBurn(APP, log as never, migrating as never);
    expect(fx.rows).toHaveLength(0);
    const broke = adapter({ nativeBalance: vi.fn(async () => 100_000_000n) });
    await runCoinBurn(APP, log as never, broke as never);
    expect(fx.rows[0]).toMatchObject({ status: "PENDING" });
    expect(broke.buy).not.toHaveBeenCalled();
  });
});
