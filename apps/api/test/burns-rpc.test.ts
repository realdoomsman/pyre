import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BurnsPageDto, PONS_TOTAL_SUPPLY } from "@pyre/shared";

/**
 * Two read paths with invariants a UI would silently misrender if broken:
 *  - /v1/burns: the ledger's running totals must be exact across page boundaries (row N's cumulative
 *    figure equals the sum of every burn at or before it, no matter where the cursor falls).
 *  - /v1/rpc: only allowlisted read methods reach the upstream RPC, batches are refused, and
 *    eth_getLogs must carry a bounded explicit block range.
 */

type BurnRow = {
  id: string;
  status: "BURNED";
  usdMicros: bigint;
  ethWei: bigint;
  tokensBought: bigint;
  tokensBurned: bigint;
  burnedUnits: bigint | null;
  attestHash: string;
  swapTx: string | null;
  burnTx: string | null;
  attestTx: string | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date;
};

const fx = vi.hoisted(() => {
  const rows: BurnRow[] = [];
  const sorted = () => [...rows].sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime() || (b.id < a.id ? -1 : 1));
  const sum = (list: BurnRow[]) => ({
    _sum: { ethWei: list.reduce((a, r) => a + r.ethWei, 0n), usdMicros: list.reduce((a, r) => a + r.usdMicros, 0n) },
    _count: { _all: list.length },
  });
  return {
    rows,
    findMany: vi.fn(async (args: { take: number; cursor?: { id: string }; skip?: number }) => {
      const all = sorted();
      const start = args.cursor ? all.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0) : 0;
      return all.slice(start, start + args.take);
    }),
    aggregate: vi.fn(async (args: { where: { OR?: Array<{ completedAt: { lt?: Date } | Date; id?: { lt: string } }> } }) => {
      const or = args.where.OR;
      if (!or) return sum(rows);
      const [strict, tie] = or as [{ completedAt: { lt: Date } }, { completedAt: Date; id: { lt: string } }];
      return sum(rows.filter((r) => r.completedAt < strict.completedAt.lt || (r.completedAt.getTime() === tie.completedAt.getTime() && r.id < tie.id.lt)));
    }),
    fetch: vi.fn(async (_url: string, init: { body: string }) => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: "0x1" }) })),
  };
});

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<object>()), prisma: {} }));
vi.mock("../src/lib/metrics.js", () => ({ db: { pyreBurn: { findMany: fx.findMany, aggregate: fx.aggregate } } }));
vi.mock("../src/lib/cache.js", () => ({ APPS_TAG: "apps", cacheKey: (...p: unknown[]) => p.join(":"), cached: <T,>(_k: unknown, _t: unknown, fn: () => Promise<T>) => fn() }));
vi.mock("../src/lib/redis.js", () => ({ redis: {} }));
vi.mock("../src/lib/queues.js", () => ({ queues: {} }));
vi.mock("../src/lib/market.js", () => ({ marketSnapshot: async () => null }));
vi.mock("../src/routes/apps.js", () => ({ listCounts: async () => ({}) }));
vi.mock("@pyre/chain", () => ({
  getEthPriceUsd: async () => 2000,
  publicClient: () => ({}),
  DEAD_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  ponsAddresses: () => ({ poolManager: "0x1", locker: "0x2", buybackVault: "0x3" }),
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: {} }),
}));

import { publicRoutes } from "../src/routes/public.js";
import { checkLogFilter, MAX_LOG_RANGE, rpc } from "../src/routes/rpc.js";

/** Runs the handler registered for `method path` on an express router with a fake req/res. */
const invoke = async (router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (e?: unknown) => void) => unknown }> } }> }, method: string, path: string, req: Partial<Request>) => {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`no route ${method} ${path}`);
  const c = { status: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  // `wrap()` returns before its promise settles, so the response object resolves the call.
  let settle: (err?: unknown) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    settle = (err?: unknown) => (err ? reject(err) : resolve());
  });
  const res = {
    status(code: number) {
      c.status = code;
      return res;
    },
    json(p: unknown) {
      c.body = p;
      settle();
      return res;
    },
    send(p: unknown) {
      c.body = p;
      settle();
      return res;
    },
    type() {
      return res;
    },
    setHeader(k: string, v: string) {
      c.headers[k] = v;
      return res;
    },
    req: { headers: {} },
  } as unknown as Response;
  const handlers = layer.route.stack;
  if (handlers.length !== 1) throw new Error(`expected one handler on ${method} ${path}`);
  handlers[0]!.handle({ query: {}, body: {}, params: {}, headers: {}, ...req } as Request, res, (e?: unknown) => settle(e ?? new Error("next() without error")));
  await done;
  return c;
};

const burn = (i: number, ethWei: bigint, at: string): BurnRow => ({
  id: `burn_${String(i).padStart(4, "0")}`,
  status: "BURNED",
  usdMicros: ethWei / 10n ** 9n,
  ethWei,
  tokensBought: 0n,
  tokensBurned: PONS_TOTAL_SUPPLY / 1000n,
  burnedUnits: null,
  attestHash: "ab".repeat(32),
  swapTx: null,
  burnTx: null,
  attestTx: null,
  error: null,
  createdAt: new Date(at),
  completedAt: new Date(at),
});

beforeEach(() => {
  fx.rows.length = 0;
  fx.fetch.mockClear();
  vi.stubGlobal("fetch", fx.fetch);
});

describe("GET /v1/burns", () => {
  it("carries exact cumulative totals across pages and reports platform totals", async () => {
    // Five burns, one per day; two share a timestamp so the tie-break path is exercised.
    for (let i = 1; i <= 5; i++) fx.rows.push(burn(i, BigInt(i) * 10n ** 15n, `2026-09-${10 + (i === 5 ? 4 : i)}T00:00:00Z`));
    const page1 = await invoke(publicRoutes, "get", "/burns", { query: { limit: "2" } });
    const body1 = BurnsPageDto.parse(page1.body);
    expect(body1.items.map((b) => b.id)).toEqual(["burn_0005", "burn_0004"]);
    expect(body1.totals).toMatchObject({ ethWei: (15n * 10n ** 15n).toString(), usdMicros: (15n * 10n ** 6n).toString(), burns: 5 });
    // Newest row carries everything; the second carries everything but the newest.
    expect(body1.items[0]!.cumulativeEthWei).toBe((15n * 10n ** 15n).toString());
    expect(body1.items[1]!.cumulativeEthWei).toBe((10n * 10n ** 15n).toString());
    expect(body1.nextCursor).toBe("burn_0004");

    const page2 = await invoke(publicRoutes, "get", "/burns", { query: { limit: "2", cursor: body1.nextCursor! } });
    const body2 = BurnsPageDto.parse(page2.body);
    expect(body2.items.map((b) => b.id)).toEqual(["burn_0003", "burn_0002"]);
    expect(body2.items[0]!.cumulativeEthWei).toBe((6n * 10n ** 15n).toString());
    expect(body2.items[1]!.cumulativeEthWei).toBe((3n * 10n ** 15n).toString());
    expect(body2.nextCursor).toBe("burn_0002");

    const page3 = await invoke(publicRoutes, "get", "/burns", { query: { limit: "2", cursor: body2.nextCursor! } });
    const body3 = BurnsPageDto.parse(page3.body);
    expect(body3.items.map((b) => b.id)).toEqual(["burn_0001"]);
    expect(body3.items[0]!.cumulativeEthWei).toBe((1n * 10n ** 15n).toString());
    expect(body3.nextCursor).toBeNull();
  });

  it("returns an empty, valid page with zero totals before any burn", async () => {
    const page = await invoke(publicRoutes, "get", "/burns", {});
    const body = BurnsPageDto.parse(page.body);
    expect(body).toEqual({ items: [], nextCursor: null, totals: { ethWei: "0", usdMicros: "0", burns: 0 } });
  });
});

describe("POST /v1/rpc", () => {
  const call = (body: unknown) => invoke(rpc, "post", "/", { body: body as Request["body"] });

  it("forwards an allowlisted read to RPC_URL and relays the raw JSON-RPC response", async () => {
    const out = await call({ jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body as string)).toEqual({ jsonrpc: "2.0", id: 7, result: "0x1" });
    expect(fx.fetch).toHaveBeenCalledTimes(1);
    expect(fx.fetch.mock.calls[0]?.[0]).toBe("https://rpc.pyre.test");
    expect(JSON.parse(fx.fetch.mock.calls[0]?.[1]?.body ?? "")).toEqual({ jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] });
  });

  it("refuses write and signing methods without touching the upstream", async () => {
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "debug_traceTransaction", "eth_accounts"]) {
      await expect(call({ jsonrpc: "2.0", id: 1, method, params: [] })).rejects.toMatchObject({ status: 403, message: "rpc_method_not_allowed" });
    }
    expect(fx.fetch).not.toHaveBeenCalled();
  });

  it("refuses batches and malformed envelopes", async () => {
    await expect(call([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }])).rejects.toMatchObject({ status: 400, message: "rpc_batch_not_allowed" });
    await expect(call({ id: 1, method: "eth_blockNumber" })).rejects.toMatchObject({ status: 400, message: "validation_failed" });
    expect(fx.fetch).not.toHaveBeenCalled();
  });

  it("bounds eth_getLogs to an explicit window of at most MAX_LOG_RANGE blocks", () => {
    expect(() => checkLogFilter({ fromBlock: "0x10", toBlock: "0x20" })).not.toThrow();
    expect(() => checkLogFilter({ blockHash: "0x" + "00".repeat(32) })).not.toThrow();
    expect(() => checkLogFilter({ fromBlock: "0x10", toBlock: "latest" })).toThrow(expect.objectContaining({ message: "rpc_log_range_required" }));
    expect(() => checkLogFilter({ address: "0x1" })).toThrow(expect.objectContaining({ message: "rpc_log_range_required" }));
    const from = 1000n;
    expect(() => checkLogFilter({ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${(from + MAX_LOG_RANGE).toString(16)}` })).not.toThrow();
    expect(() => checkLogFilter({ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${(from + MAX_LOG_RANGE + 1n).toString(16)}` })).toThrow(
      expect.objectContaining({ message: "rpc_log_range_too_wide" }),
    );
    expect(() => checkLogFilter({ fromBlock: "0x20", toBlock: "0x10" })).toThrow(expect.objectContaining({ message: "rpc_log_range_too_wide" }));
  });
});
