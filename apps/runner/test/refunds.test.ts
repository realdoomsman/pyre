import type * as Db from "@pyre/db";
import { REFUND_SNAPSHOT, microsToWei } from "@pyre/shared";
import { encodeAbiParameters, encodeEventTopics, getAddress, numberToHex, parseAbi, type Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PYRE refunds: holding is tracked from PYRE Transfer logs (min balance only ever falls), the
 * allocation moves REFUND ledger money onto holders by what they are still eligible for (owed
 * scaled by the snapshot PYRE still held) in one transaction and never on stale holding, payouts
 * take the credit before any SOL moves (marker), a deterministic failure gives it back, an
 * unconfirmed send keeps it taken until the signature resolves, and the freeze blocks payouts.
 */

type Status = "PENDING" | "SENT" | "CONFIRMED" | "FAILED";
interface Holder {
  address: string;
  balanceUnits: unknown;
  currentBalanceUnits: unknown;
  minBalanceUnits: unknown;
  owedWei: unknown;
  settledWei: unknown;
  creditMicros: bigint;
  paidMicros: bigint;
  solWallet: string | null;
  linkPendingUntil?: Date | null;
}
interface Payout {
  id: string;
  address: string;
  solWallet: string;
  usdMicros: bigint;
  lamports: unknown;
  solPriceUsd: number;
  status: Status;
  txSig: string | null;
  error: string | null;
  lastValidBlockHeight?: bigint | null;
  createdAt: Date;
  confirmedAt: Date | null;
}

const fx = vi.hoisted(() => {
  class SolanaTransactionFailedError extends Error {}
  class SolanaTransactionUnconfirmedError extends Error {
    constructor(
      readonly signature: string,
      override readonly cause?: unknown,
      readonly lastValidBlockHeight?: number,
    ) {
      super(`solana transaction ${signature} could not be confirmed`);
    }
  }
  const state = {
    holders: [] as Holder[],
    payouts: [] as Payout[],
    ledger: [] as Array<{ account: string; deltaMicros: bigint; refType: string; refId: string }>,
    settings: {} as Record<string, unknown>,
  };
  return { state, SolanaTransactionFailedError, SolanaTransactionUnconfirmedError, audit: vi.fn(), withLock: vi.fn() };
});

const { big, dec } = await vi.importActual<typeof Db>("@pyre/db");

const applyNum = (cur: bigint, v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  const op = v as { increment?: bigint; decrement?: bigint };
  return cur + (op.increment ?? 0n) - (op.decrement ?? 0n);
};
const applyHolder = (h: Holder, data: Record<string, unknown>): void => {
  for (const [k, v] of Object.entries(data)) {
    if (k === "creditMicros" || k === "paidMicros") h[k] = applyNum(h[k], v);
    else (h as unknown as Record<string, unknown>)[k] = v;
  }
};

/** `OR: [{ linkPendingUntil: null }, { linkPendingUntil: { lte: now } }]` → the relink cooldown is over at `now`. */
const cooldownOver = (h: Holder, where: Record<string, unknown>): boolean => {
  const or = where.OR as Array<{ linkPendingUntil: { lte: Date } | null }> | undefined;
  if (!or) return true;
  const now = or.find((c) => c.linkPendingUntil !== null)!.linkPendingUntil!.lte;
  return !h.linkPendingUntil || h.linkPendingUntil <= now;
};
const refundHolder = {
  fields: { owedWei: "owedWei" },
  findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
    if (!where) return fx.state.holders.map((h) => ({ ...h }));
    if ("settledWei" in where) return fx.state.holders.filter((h) => big(h.settledWei as never) < big(h.owedWei as never) && big(h.minBalanceUnits as never) > 0n).map((h) => ({ ...h }));
    return fx.state.holders
      .filter((h) => h.solWallet && h.creditMicros >= 1_000_000n && cooldownOver(h, where))
      .sort((a, b) => (b.creditMicros > a.creditMicros ? 1 : -1))
      .map((h) => ({ ...h }));
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const h = fx.state.holders.find(
      (x) =>
        x.address === where.address &&
        (where.settledWei === undefined || big(x.settledWei as never) === big(where.settledWei as never)) &&
        (where.creditMicros === undefined || x.creditMicros === where.creditMicros) &&
        (where.solWallet === undefined || x.solWallet === where.solWallet) &&
        cooldownOver(x, where),
    );
    if (!h) return { count: 0 };
    applyHolder(h, data);
    return { count: 1 };
  }),
  update: vi.fn(async ({ where, data }: { where: { address: string }; data: Record<string, unknown> }) => {
    const h = fx.state.holders.find((x) => x.address === where.address)!;
    applyHolder(h, data);
    return { ...h };
  }),
};
let seq = 0;
const refundPayout = {
  create: vi.fn(async ({ data }: { data: Partial<Payout> }) => {
    const p: Payout = { id: `rp_${++seq}`, status: "PENDING", txSig: null, error: null, lastValidBlockHeight: null, createdAt: new Date(), confirmedAt: null, ...data } as Payout;
    fx.state.payouts.push(p);
    return { ...p };
  }),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Payout> }) => {
    const p = fx.state.payouts.find((x) => x.id === where.id)!;
    Object.assign(p, data);
    return { ...p };
  }),
  findMany: vi.fn(async ({ where }: { where: { status: Status } }) => fx.state.payouts.filter((p) => p.status === where.status).map((p) => ({ ...p }))),
};
const ledgerEntry = {
  aggregate: vi.fn(async () => ({ _sum: { deltaMicros: fx.state.ledger.reduce((a, e) => a + e.deltaMicros, 0n) } })),
  create: vi.fn(async ({ data }: { data: (typeof fx.state.ledger)[number] }) => {
    fx.state.ledger.push(data);
    return data;
  }),
};
const platformSetting = {
  findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (where.key in fx.state.settings ? { key: where.key, value: fx.state.settings[where.key] } : null)),
  upsert: vi.fn(async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
    fx.state.settings[where.key] = update.value;
    return { key: where.key, value: update.value };
  }),
};
const client = { refundHolder, refundPayout, ledgerEntry, platformSetting };
const prisma = {
  ...client,
  // Interactive transactions roll back on throw, like Postgres.
  $transaction: async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    // Rows are only ever mutated by field replacement (Decimals are immutable), so shallow copies suffice.
    const snapshot = { holders: fx.state.holders.map((h) => ({ ...h })), payouts: fx.state.payouts.map((p) => ({ ...p })), ledger: [...fx.state.ledger], settings: { ...fx.state.settings } };
    try {
      return await (arg as (tx: typeof client) => Promise<unknown>)(client);
    } catch (err) {
      fx.state.holders.splice(0, Infinity, ...snapshot.holders);
      fx.state.payouts.splice(0, Infinity, ...snapshot.payouts);
      fx.state.ledger.splice(0, Infinity, ...snapshot.ledger);
      fx.state.settings = snapshot.settings;
      throw err;
    }
  },
};

const TREASURY = { chain: "solana", address: "Treasury1111111111111111111111111111111111", signer: { k: "treasury" } };
interface TransferLog {
  blockNumber: bigint;
  logIndex: number;
  args: { from: string; to: string; value: bigint };
}
/** PYRE Transfer logs on Robinhood Chain; the batch serves the requested block range in whatever order they were pushed. */
const transfers: TransferLog[] = [];
const ZERO32 = `0x${"00".repeat(32)}` as const;
const tokenAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
/** A Transfer log as `eth_getLogs` returns it over the wire. */
const rawLog = (l: TransferLog) => ({
  address: REFUND_SNAPSHOT.token,
  topics: encodeEventTopics({ abi: tokenAbi, eventName: "Transfer", args: { from: l.args.from as Address, to: l.args.to as Address } }),
  data: encodeAbiParameters([{ type: "uint256" }], [l.args.value]),
  blockNumber: numberToHex(l.blockNumber),
  logIndex: numberToHex(l.logIndex),
  blockHash: ZERO32,
  transactionHash: ZERO32,
  transactionIndex: "0x0",
  removed: false,
});
const rpc = {
  getBlockNumber: vi.fn(async () => BigInt(REFUND_SNAPSHOT.block) + 700n),
  /** Highest block the node answering the batch has; a lagging replica answers null for later blocks. */
  nodeHead: Infinity as number | bigint,
};
/** One JSON-RPC batch: [eth_getBlockByNumber(end), eth_getLogs(start..end)], answered by one node. */
const serveBatch = async (calls: Array<{ method: string; params: unknown[] }>) => {
  const end = BigInt(calls[0]!.params[0] as string);
  const filter = calls[1]!.params[0] as { fromBlock: string; toBlock: string };
  const [from, to] = [BigInt(filter.fromBlock), BigInt(filter.toBlock)];
  const has = (n: bigint) => rpc.nodeHead === Infinity || n <= BigInt(rpc.nodeHead);
  return [has(end) ? { number: numberToHex(end) } : null, transfers.filter((l) => l.blockNumber >= from && l.blockNumber <= to && has(l.blockNumber)).map(rawLog)];
};
const chain = {
  LOG_CHUNK_BLOCKS: 10_000n,
  publicClient: () => rpc,
  rpcBatch: vi.fn(serveBatch),
  tokenAbi,
  SolanaTransactionFailedError: fx.SolanaTransactionFailedError,
  SolanaTransactionUnconfirmedError: fx.SolanaTransactionUnconfirmedError,
  adapterFor: () => ({ treasury: () => TREASURY }),
  solSigner: (a: typeof TREASURY) => a.signer,
  solanaEnabled: () => true,
  getEthPriceUsd: vi.fn(async () => 4000),
  getSolPriceUsd: vi.fn(async () => 100),
  getSolBalance: vi.fn(async () => 10_000_000_000n),
  transferSol: vi.fn(async () => ({ signature: "sigOK", slot: 1, tx: {} })),
  getSignatureStatuses: vi.fn(),
  getBlockHeight: vi.fn(async () => 0),
  solanaConnection: () => ({ getSignatureStatuses: chain.getSignatureStatuses, getBlockHeight: chain.getBlockHeight }),
};

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma }));
vi.mock("@pyre/chain", () => chain);
vi.mock("../src/lib/audit.js", () => ({ audit: fx.audit }));
vi.mock("../src/lib/lock.js", () => ({ withLock: fx.withLock }));

// Dynamic import: the module binds `@pyre/db` and `@pyre/chain` at load time, so it must come after the mocks.
const { allocateRefundPool, payRefunds, resolveSentRefunds, runRefunds, trackHolding, REFUND_HOLD_CURSOR_KEY } = await import("../src/workers/chain/refunds.js");

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const ETH = 10n ** 18n;

const holder = (address: string, owedWei: bigint, over: Partial<Holder> = {}): Holder => ({
  address,
  balanceUnits: dec(1000n),
  currentBalanceUnits: dec(1000n),
  minBalanceUnits: dec(1000n),
  owedWei: dec(owedWei),
  settledWei: dec(0n),
  creditMicros: 0n,
  paidMicros: 0n,
  solWallet: null,
  ...over,
});
const get = (address: string) => fx.state.holders.find((h) => h.address === address)!;

beforeEach(() => {
  fx.state.holders.length = 0;
  fx.state.payouts.length = 0;
  fx.state.ledger.length = 0;
  fx.state.settings = {};
  transfers.length = 0;
  delete process.env.PAYOUTS_FROZEN;
  vi.clearAllMocks();
  chain.transferSol.mockImplementation(async () => ({ signature: "sigOK", slot: 1, tx: {} }));
  chain.getSolBalance.mockImplementation(async () => 10_000_000_000n);
  rpc.getBlockNumber.mockImplementation(async () => BigInt(REFUND_SNAPSHOT.block) + 700n);
  rpc.nodeHead = Infinity;
  chain.rpcBatch.mockImplementation(serveBatch);
  chain.getBlockHeight.mockImplementation(async () => 0);
  fx.withLock.mockImplementation(async (_redis: unknown, _key: string, _ttl: number, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }));
});

const A = getAddress(`0x${"a1".repeat(20)}`);
const B = getAddress(`0x${"b2".repeat(20)}`);
const X = getAddress(`0x${"c3".repeat(20)}`);
const at = (offset: number) => BigInt(REFUND_SNAPSHOT.block) + BigInt(offset);
const transfer = (offset: number, logIndex: number, from: string, to: string, value: bigint): void => {
  transfers.push({ blockNumber: at(offset), logIndex, args: { from, to, value } });
};
const units = (address: string) => ({ current: big(get(address).currentBalanceUnits as never), min: big(get(address).minBalanceUnits as never) });

describe("trackHolding", () => {
  it("applies transfers in (block, logIndex) order up to the reorg-safe head; min never rises", async () => {
    fx.state.holders.push(holder(A, ETH), holder(B, ETH));
    // Pushed out of order: in chain order A sends 600, receives 1000, then sends 500 → lowest point 400.
    transfer(20, 0, A, X, 500n);
    transfer(10, 1, X, A, 1000n);
    transfer(10, 0, A, X, 600n);
    transfer(101, 0, A, X, 1n); // inside the 600-block reorg margin: not applied yet

    expect(await trackHolding(log)).toBe(true);
    expect(units(A)).toEqual({ current: 900n, min: 400n });
    expect(units(B)).toEqual({ current: 1000n, min: 1000n });
    expect(fx.state.settings[REFUND_HOLD_CURSOR_KEY]).toBe(at(100).toString());

    // Next pass resumes after the cursor: only the new log applies, and buying back never lifts min.
    rpc.getBlockNumber.mockResolvedValueOnce(at(710));
    transfer(102, 0, X, A, 5000n);
    expect(await trackHolding(log)).toBe(true);
    expect(units(A)).toEqual({ current: 5899n, min: 400n });
  });

  it("writes neither balances nor cursor when a log query fails", async () => {
    fx.state.holders.push(holder(A, ETH));
    transfer(10, 0, A, X, 600n);
    chain.rpcBatch.mockRejectedValueOnce(new Error("rpc down"));
    await expect(trackHolding(log)).rejects.toThrow(/rpc down/);
    expect(units(A)).toEqual({ current: 1000n, min: 1000n });
    expect(fx.state.settings[REFUND_HOLD_CURSOR_KEY]).toBeUndefined();
  });

  it("never moves the cursor while the snapshot is not loaded, so later-loaded holders replay every transfer", async () => {
    transfer(10, 0, A, X, 600n);
    expect(await trackHolding(log)).toBe(false);
    expect(fx.state.settings[REFUND_HOLD_CURSOR_KEY]).toBeUndefined();
    expect(chain.rpcBatch).not.toHaveBeenCalled();

    fx.state.holders.push(holder(A, ETH));
    expect(await trackHolding(log)).toBe(true);
    expect(units(A)).toEqual({ current: 400n, min: 400n });
  });

  it("fails the chunk when the node serving the logs has not reached its end block", async () => {
    fx.state.holders.push(holder(A, ETH));
    transfer(10, 0, A, X, 600n);
    transfer(90, 0, A, X, 400n);
    rpc.nodeHead = at(50); // lagging replica: would answer only the first transfer
    await expect(trackHolding(log)).rejects.toThrow(/has not reached block/);
    expect(units(A)).toEqual({ current: 1000n, min: 1000n });
    expect(fx.state.settings[REFUND_HOLD_CURSOR_KEY]).toBeUndefined();
    // The block and its logs are asked in one batch, so they come from the same node.
    expect(chain.rpcBatch.mock.calls[0]![0].map((c: { method: string }) => c.method)).toEqual(["eth_getBlockByNumber", "eth_getLogs"]);

    rpc.nodeHead = Infinity;
    expect(await trackHolding(log)).toBe(true);
    expect(units(A)).toEqual({ current: 0n, min: 0n });
  });

  it("replays idempotently from the snapshot when the cursor is deleted", async () => {
    fx.state.holders.push(holder(A, ETH), holder(B, ETH));
    transfer(10, 0, A, X, 600n);
    transfer(20, 0, X, A, 100n);
    expect(await trackHolding(log)).toBe(true);
    const first = { a: units(A), b: units(B) };
    expect(first.a).toEqual({ current: 500n, min: 400n });

    delete fx.state.settings[REFUND_HOLD_CURSOR_KEY];
    expect(await trackHolding(log)).toBe(true);
    expect({ a: units(A), b: units(B) }).toEqual(first);
  });
});

describe("allocateRefundPool", () => {
  it("debits the pool once and credits holders pro-rata to what they are still owed", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 30_000_000n, refType: "PlatformFee", refId: "sig1" });
    fx.state.holders.push(holder("0xA", 2n * ETH), holder("0xB", 2n * ETH, { settledWei: dec(ETH) }), holder("0xC", ETH, { settledWei: dec(ETH) }));

    const runId = await allocateRefundPool(log);

    expect(runId).toEqual(expect.any(String));
    expect(fx.state.ledger).toContainEqual(expect.objectContaining({ account: "REFUND", deltaMicros: -30_000_000n, refType: "RefundAllocation", refId: runId }));
    expect(get("0xA").creditMicros).toBe(20_000_000n);
    expect(get("0xB").creditMicros).toBe(10_000_000n);
    expect(big(get("0xA").settledWei as never)).toBe(microsToWei(20_000_000n, 4000));
    expect(big(get("0xB").settledWei as never)).toBe(ETH + microsToWei(10_000_000n, 4000));
    expect(get("0xC").creditMicros).toBe(0n);
  });

  it("keeps the excess in the pool once caps are hit and never settles past owed", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 50_000_000n, refType: "PlatformFee", refId: "sig1" });
    const owed = 2_500_000_000_000_000n; // 0.0025 ETH = $10 at $4000
    fx.state.holders.push(holder("0xA", owed));

    await allocateRefundPool(log);

    expect(get("0xA").creditMicros).toBe(10_000_000n);
    expect(big(get("0xA").settledWei as never)).toBe(owed);
    expect(fx.state.ledger.reduce((a, e) => a + e.deltaMicros, 0n)).toBe(40_000_000n);
  });

  it("writes nothing when a holder changes under the allocation", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 30_000_000n, refType: "PlatformFee", refId: "sig1" });
    fx.state.holders.push(holder("0xA", ETH), holder("0xB", ETH));
    refundHolder.updateMany.mockImplementationOnce(async () => ({ count: 1 })).mockImplementationOnce(async () => ({ count: 0 }));

    await expect(allocateRefundPool(log)).rejects.toThrow(/changed during allocation/);
    expect(fx.state.ledger).toHaveLength(1);
    expect(get("0xA").creditMicros).toBe(0n);
  });

  it("does nothing below the minimum pool", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 999_999n, refType: "PlatformFee", refId: "sig1" });
    fx.state.holders.push(holder("0xA", ETH));
    expect(await allocateRefundPool(log)).toBeNull();
    expect(get("0xA").creditMicros).toBe(0n);
  });

  it("never allocates more than owed to a holder who bought more after the snapshot", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 50_000_000n, refType: "PlatformFee", refId: "sig1" });
    const owed = 2_500_000_000_000_000n; // 0.0025 ETH = $10 at $4000
    fx.state.holders.push(holder(A, owed));
    transfer(10, 0, X, A, 9000n);

    await trackHolding(log);
    await allocateRefundPool(log);

    expect(units(A)).toEqual({ current: 10_000n, min: 1000n });
    expect(get(A).creditMicros).toBe(10_000_000n);
    expect(big(get(A).settledWei as never)).toBe(owed);
  });

  it("allocates nothing to a holder who sold out; the pool goes to those still holding", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 30_000_000n, refType: "PlatformFee", refId: "sig1" });
    fx.state.holders.push(holder(A, ETH), holder(B, ETH));
    transfer(10, 0, A, X, 1000n);
    transfer(11, 0, X, A, 1000n); // buying back does not restore eligibility

    await trackHolding(log);
    await allocateRefundPool(log);

    expect(get(A)).toMatchObject({ creditMicros: 0n });
    expect(big(get(A).settledWei as never)).toBe(0n);
    expect(get(B).creditMicros).toBe(30_000_000n);
  });

  it("scales a partial seller's remaining owed by the share of snapshot PYRE kept", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 30_000_000n, refType: "PlatformFee", refId: "sig1" });
    // A owed 2 ETH, kept half → eligible 1 ETH; B owed 1 ETH, kept all → equal shares.
    fx.state.holders.push(holder(A, 2n * ETH), holder(B, ETH));
    transfer(10, 0, A, X, 500n);

    await trackHolding(log);
    await allocateRefundPool(log);

    expect(get(A).creditMicros).toBe(15_000_000n);
    expect(get(B).creditMicros).toBe(15_000_000n);
  });

  it("caps a seller at eligibility already settled: no further allocation, no clawback", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 30_000_000n, refType: "PlatformFee", refId: "sig1" });
    // Settled 1 ETH of 2 owed while holding, then sold 3/4 → eligible 0.5 ETH < settled.
    fx.state.holders.push(holder(A, 2n * ETH, { settledWei: dec(ETH), creditMicros: 7_000_000n, minBalanceUnits: dec(250n) }), holder(B, ETH));

    await allocateRefundPool(log);

    expect(get(A)).toMatchObject({ creditMicros: 7_000_000n });
    expect(big(get(A).settledWei as never)).toBe(ETH);
    expect(get(B).creditMicros).toBe(30_000_000n);
  });
});

describe("runRefunds", () => {
  const ctx = { log, redis: {} } as never;

  it("skips allocation when holding tracking fails, but still pays credit already earned", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 30_000_000n, refType: "PlatformFee", refId: "sig1" });
    fx.state.holders.push(holder(A, ETH, { creditMicros: 5_000_000n, solWallet: "SolA111111111111111111111111111111111111111" }), holder(B, ETH));
    chain.rpcBatch.mockRejectedValueOnce(new Error("rpc down"));

    await runRefunds(ctx);

    expect(fx.state.ledger).toHaveLength(1);
    expect(get(B).creditMicros).toBe(0n);
    expect(get(A)).toMatchObject({ creditMicros: 0n, paidMicros: 5_000_000n });
  });

  it("skips allocation while a holding backlog remains, and allocates once caught up", async () => {
    fx.state.ledger.push({ account: "REFUND", deltaMicros: 30_000_000n, refType: "PlatformFee", refId: "sig1" });
    fx.state.holders.push(holder(A, ETH), holder(B, ETH));
    rpc.getBlockNumber.mockResolvedValue(at(400_600));
    transfer(350_000, 0, A, X, 1000n); // A sells out beyond the first pass's 300k-block window

    await runRefunds(ctx);
    expect(fx.state.ledger).toHaveLength(1);

    await runRefunds(ctx);
    expect(units(A).min).toBe(0n);
    expect(get(A).creditMicros).toBe(0n);
    expect(get(B).creditMicros).toBe(30_000_000n);
  });
});

describe("payRefunds", () => {
  const linked = () => fx.state.holders.push(holder("0xA", ETH, { creditMicros: 5_000_000n, solWallet: "SolA111111111111111111111111111111111111111" }));

  it("pays linked credit in SOL at the current price and records it paid", async () => {
    linked();
    expect(await payRefunds(log)).toBe(1);
    expect(chain.transferSol).toHaveBeenCalledWith(TREASURY.signer, "SolA111111111111111111111111111111111111111", 50_000_000n); // $5 at $100/SOL
    expect(fx.state.payouts[0]).toMatchObject({ status: "CONFIRMED", txSig: "sigOK", usdMicros: 5_000_000n });
    expect(get("0xA")).toMatchObject({ creditMicros: 0n, paidMicros: 5_000_000n });
  });

  it("is blocked by PAYOUTS_FROZEN=1 and by pause_refunds", async () => {
    linked();
    process.env.PAYOUTS_FROZEN = "1";
    expect(await payRefunds(log)).toBe(0);
    delete process.env.PAYOUTS_FROZEN;
    fx.state.settings.pause_refunds = true;
    expect(await payRefunds(log)).toBe(0);
    expect(chain.transferSol).not.toHaveBeenCalled();
    expect(fx.state.payouts).toHaveLength(0);
    expect(get("0xA").creditMicros).toBe(5_000_000n);
  });

  it("restores the credit when the transfer fails deterministically", async () => {
    linked();
    chain.transferSol.mockRejectedValueOnce(new fx.SolanaTransactionFailedError("insufficient funds"));
    await payRefunds(log);
    expect(fx.state.payouts[0]).toMatchObject({ status: "FAILED" });
    expect(get("0xA")).toMatchObject({ creditMicros: 5_000_000n, paidMicros: 0n });
  });

  it("keeps the credit taken while an unconfirmed send is SENT, recording when its blockhash dies", async () => {
    linked();
    chain.transferSol.mockRejectedValueOnce(new fx.SolanaTransactionUnconfirmedError("sigMaybe", undefined, 5_000));
    await payRefunds(log);
    expect(fx.state.payouts[0]).toMatchObject({ status: "SENT", txSig: "sigMaybe", lastValidBlockHeight: 5_000n });
    expect(get("0xA")).toMatchObject({ creditMicros: 0n, paidMicros: 0n });
  });

  it("stops mid-run when pause_refunds is set between two payouts", async () => {
    linked();
    fx.state.holders.push(holder("0xB", ETH, { creditMicros: 4_000_000n, solWallet: "SolB111111111111111111111111111111111111111" }));
    chain.transferSol.mockImplementationOnce(async () => {
      fx.state.settings.pause_refunds = true;
      return { signature: "sigOK", slot: 1, tx: {} };
    });
    expect(await payRefunds(log)).toBe(1);
    expect(chain.transferSol).toHaveBeenCalledTimes(1);
    expect(get("0xB").creditMicros).toBe(4_000_000n);
  });

  it("holds a relinked wallet's payouts until the cooldown ends", async () => {
    const until = new Date("2026-10-06T12:00:00Z");
    fx.state.holders.push(holder("0xA", ETH, { creditMicros: 5_000_000n, solWallet: "SolNew11111111111111111111111111111111111111", linkPendingUntil: until }));
    expect(await payRefunds(log, new Date(until.getTime() - 1))).toBe(0);
    expect(chain.transferSol).not.toHaveBeenCalled();
    expect(get("0xA").creditMicros).toBe(5_000_000n);

    expect(await payRefunds(log, until)).toBe(1);
    expect(chain.transferSol).toHaveBeenCalledWith(TREASURY.signer, "SolNew11111111111111111111111111111111111111", 50_000_000n);
  });

  it("stops at the treasury floor", async () => {
    linked();
    chain.getSolBalance.mockResolvedValueOnce(120_000_000n); // 0.12 SOL − 0.05 SOL payout < 0.1 SOL floor
    expect(await payRefunds(log)).toBe(0);
    expect(chain.transferSol).not.toHaveBeenCalled();
  });
});

describe("resolveSentRefunds", () => {
  const sent = (txSig: string, lastValidBlockHeight: bigint | null) => {
    fx.state.payouts.push({ id: txSig, address: "0xA", solWallet: "SolA", usdMicros: 5_000_000n, lamports: dec(1n), solPriceUsd: 100, status: "SENT", txSig, error: null, lastValidBlockHeight, createdAt: new Date(0), confirmedAt: null });
  };

  it("confirms landed signatures and restores failed ones or ones whose blockhash provably expired", async () => {
    fx.state.holders.push(holder("0xA", ETH));
    sent("landed", 900n);
    sent("reverted", 900n);
    sent("expired", 999n);
    sent("notYet", 1_000n);
    sent("processed", 900n);
    sent("noHeight", null);
    chain.getBlockHeight.mockResolvedValueOnce(1_000);
    chain.getSignatureStatuses.mockResolvedValueOnce({
      value: [
        { confirmationStatus: "finalized", err: null },
        { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } },
        null,
        null,
        { confirmationStatus: "processed", err: null },
        null,
      ],
    });

    expect(await resolveSentRefunds(log)).toBe(3);
    const by = (id: string) => fx.state.payouts.find((p) => p.id === id)!.status;
    expect(["landed", "reverted", "expired", "notYet", "processed", "noHeight"].map(by)).toEqual(["CONFIRMED", "FAILED", "FAILED", "SENT", "SENT", "SENT"]);
    expect(get("0xA")).toMatchObject({ paidMicros: 5_000_000n, creditMicros: 10_000_000n });
    expect(chain.getBlockHeight).toHaveBeenCalledWith("finalized");
    expect(chain.getSignatureStatuses).toHaveBeenCalledWith(expect.any(Array), { searchTransactionHistory: true });
  });
});
