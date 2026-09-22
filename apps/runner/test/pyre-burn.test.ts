import type * as Db from "@pyre/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The $PYRE buy-and-burn walks a persisted PENDING → SWAPPING → SWAPPED → BURNED row so that a
 * failure between the buy and the burn is recoverable: the next pass must resume at the burn
 * (never re-buy), a buy whose outcome is unknown must park the row for an operator (never re-buy),
 * and only a BURNED row counts as burned. The ledger debit is written with the PENDING row.
 */

type Status = "PENDING" | "SWAPPING" | "SWAPPED" | "BURNED" | "FAILED";
interface Row {
  id: string;
  status: Status;
  usdMicros: bigint;
  ethWei: unknown;
  tokensBought: unknown;
  tokensBurned: unknown;
  burnedUnits: unknown;
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
  const ledger: Array<{ account: string; deltaMicros: bigint; refType: string; refId: string }> = [];
  let seq = 0;
  const pyreBurn = {
    findFirst: vi.fn(async ({ where }: { where: { status: Status } }) => rows.find((r) => r.status === where.status) ?? null),
    create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
      const row: Row = {
        id: `pb_${++seq}`,
        status: "PENDING",
        usdMicros: 0n,
        ethWei: 0,
        tokensBought: 0,
        tokensBurned: 0,
        burnedUnits: null,
        attestHash: "",
        swapTx: null,
        burnTx: null,
        attestTx: null,
        error: null,
        createdAt: new Date(),
        completedAt: null,
        ...data,
      };
      rows.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: Status }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id && r.status === where.status);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error(`no row ${where.id}`);
      Object.assign(row, data);
      return { ...row };
    }),
  };
  const ledgerEntry = {
    aggregate: vi.fn(async () => ({ _sum: { deltaMicros: ledger.reduce((a, e) => a + e.deltaMicros, 20_000_000n) } })),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => [{ id: "credit1" }, { id: "credit2" }]),
    create: vi.fn(async ({ data }: { data: (typeof ledger)[number] }) => {
      ledger.push(data);
      return data;
    }),
  };
  const prisma = { pyreBurn, ledgerEntry, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ pyreBurn, ledgerEntry }) };
  const chain = {
    readLaunch: vi.fn(),
    getEthPriceUsd: vi.fn(async () => 2000),
    getEthBalance: vi.fn(async () => 10n ** 18n),
    getErc20Balance: vi.fn(async () => 500n),
    curveQuoteBuy: vi.fn(async () => ({ tokensOut: 500n })),
    curveBuy: vi.fn(async () => ({ hash: "0xswap", tokensOut: 500n, refundWei: 0n })),
    burnTokens: vi.fn(async () => "0xburn"),
    attestBurn: vi.fn(async () => "0xattest"),
    totalSupply: vi.fn(async () => 1_000_000n),
  };
  return { rows, ledger, prisma, chain, audit: vi.fn() };
});

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma: fx.prisma }));
vi.mock("@pyre/chain", () => ({
  ...fx.chain,
  v4QuoteExactIn: vi.fn(),
  v4SwapExactIn: vi.fn(),
  treasury: () => ({ address: "0x00000000000000000000000000000000000000AA", account: { address: "0x00000000000000000000000000000000000000AA" } }),
  attestationHash: () => "0x" + "11".repeat(32),
  publicClient: () => ({ readContract: fx.chain.totalSupply }),
  tokenAbi: [],
}));
vi.mock("../src/workers/chain/env.js", () => ({ chainWorkerEnv: () => ({ PYRE_TOKEN: "0x1111111111111111111111111111111111111111" }) }));
vi.mock("../src/lib/audit.js", () => ({ audit: fx.audit }));
vi.mock("../src/lib/lock.js", () => ({ withLock: vi.fn() }));

// Dynamic import: the module binds `@pyre/chain` and `@pyre/db` at load time, so it must come after the mocks.
const { runPyreBuyback } = await import("../src/workers/chain/buyback.js");
const { big } = await import("@pyre/db");

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const CURVE_LAUNCH = { exists: true, phase: 0, token: "0x1111111111111111111111111111111111111111", curve: "0x00000000000000000000000000000000000000c0" };

beforeEach(() => {
  fx.rows.length = 0;
  fx.ledger.length = 0;
  vi.clearAllMocks();
  fx.chain.readLaunch.mockResolvedValue(CURVE_LAUNCH);
  fx.chain.getEthPriceUsd.mockResolvedValue(2000);
  fx.chain.getEthBalance.mockResolvedValue(10n ** 18n);
  fx.chain.getErc20Balance.mockResolvedValue(500n);
  fx.chain.curveQuoteBuy.mockResolvedValue({ tokensOut: 500n });
  fx.chain.curveBuy.mockResolvedValue({ hash: "0xswap", tokensOut: 500n, refundWei: 0n });
  fx.chain.burnTokens.mockResolvedValue("0xburn");
  fx.chain.attestBurn.mockResolvedValue("0xattest");
  fx.chain.totalSupply.mockResolvedValueOnce(1_000_000n).mockResolvedValueOnce(999_500n);
});

describe("$PYRE buy-and-burn state machine", () => {
  it("opens a PENDING row with the ledger debit, buys, burns exactly what was bought, attests and settles BURNED", async () => {
    await runPyreBuyback(log);

    expect(fx.ledger).toContainEqual(expect.objectContaining({ account: "PYRE_TOKEN", deltaMicros: -20_000_000n, refType: "PyreBurn", refId: "pb_1" }));
    expect(fx.chain.curveBuy).toHaveBeenCalledTimes(1);
    expect(fx.chain.burnTokens).toHaveBeenCalledWith(expect.anything(), CURVE_LAUNCH.token, 500n);
    const row = fx.rows[0]!;
    expect(row).toMatchObject({ status: "BURNED", swapTx: "0xswap", burnTx: "0xburn", attestTx: "0xattest", error: null });
    expect(big(row.burnedUnits)).toBe(500n);
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(fx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "PYRE_BURN", targetType: "PyreBurn", targetId: "pb_1" }));
  });

  it("a burn that fails after the buy leaves the row SWAPPED with the error, and the next pass resumes at the burn without re-buying", async () => {
    fx.chain.burnTokens.mockRejectedValueOnce(new Error("rpc timeout"));
    await runPyreBuyback(log);

    const row = fx.rows[0]!;
    expect(row).toMatchObject({ status: "SWAPPED", swapTx: "0xswap", burnTx: null, error: "rpc timeout" });
    expect(big(row.tokensBought)).toBe(500n);
    expect(fx.ledger).toHaveLength(1); // the debit is never duplicated

    fx.chain.totalSupply.mockReset().mockResolvedValueOnce(1_000_000n).mockResolvedValueOnce(999_500n);
    await runPyreBuyback(log);

    expect(fx.chain.curveBuy).toHaveBeenCalledTimes(1);
    expect(fx.chain.burnTokens).toHaveBeenCalledTimes(2);
    expect(row).toMatchObject({ status: "BURNED", burnTx: "0xburn", attestTx: "0xattest", error: null });
    expect(fx.rows).toHaveLength(1);
    expect(fx.ledger).toHaveLength(1);
  });

  it("a buy whose outcome is unknown parks the row in SWAPPING and is never re-bought", async () => {
    fx.chain.curveBuy.mockRejectedValueOnce(new Error("receipt timeout"));
    await runPyreBuyback(log);

    const row = fx.rows[0]!;
    expect(row).toMatchObject({ status: "SWAPPING", error: "receipt timeout" });
    expect(fx.chain.burnTokens).not.toHaveBeenCalled();

    await runPyreBuyback(log);

    expect(fx.chain.curveBuy).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("SWAPPING");
    expect(fx.rows).toHaveLength(1);
  });

  it("refuses to burn more than was bought, so staked $PYRE in treasury custody is never touched", async () => {
    fx.chain.getErc20Balance.mockResolvedValue(499n);
    await runPyreBuyback(log);

    expect(fx.chain.burnTokens).not.toHaveBeenCalled();
    expect(fx.rows[0]).toMatchObject({ status: "SWAPPED", error: expect.stringContaining("refusing to burn staked custody") });
  });

  it("does nothing below the buyback minimum", async () => {
    fx.prisma.ledgerEntry.aggregate.mockResolvedValueOnce({ _sum: { deltaMicros: 4_000_000n } });
    await runPyreBuyback(log);

    expect(fx.rows).toHaveLength(0);
    expect(fx.chain.curveBuy).not.toHaveBeenCalled();
  });
});
