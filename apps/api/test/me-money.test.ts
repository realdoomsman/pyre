import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two money-out flows real users depend on:
 *  - claim: a launcher converts their accrued fee share (LAUNCHER ledger balance) into an ETH payout
 *    from the treasury. The double-spend guard (write the clearing entry, re-check, roll back on any
 *    failure) is the load-bearing part — a bug here double-pays or strands fees.
 *  - withdraw: server-signs an ETH transfer, or a USDG EIP-3009 authorization the treasury relays,
 *    out of the caller's custodial wallet. The balance gates, the gas reserve and the daily USD cap
 *    are what stop a transfer that would fail mid-flight or drain a compromised session.
 * Everything below the HTTP layer is faked, so this is pure decision-logic with no I/O.
 */

interface LedgerRow {
  id: string;
  account: string;
  deltaMicros: bigint;
  refType?: string;
  refId?: string;
  memo?: string;
}

const fx = vi.hoisted(() => {
  const ledger: LedgerRow[] = [];
  const treasuryEntries: LedgerRow[] = [];
  const state = { ethPriceUsd: 2000, transferOk: true, ethBalance: 0n, usdgBalance: 0n, dailyUsed: 0n };
  let seq = 0;
  return {
    ledger,
    treasuryEntries,
    state,
    getEthPriceUsd: vi.fn(async () => state.ethPriceUsd),
    transferEth: vi.fn(async (_from: unknown, _to: string, _wei: bigint) => {
      if (!state.transferOk) throw new Error("rpc down");
      return "0x" + "a1".repeat(32);
    }),
    signUsdgAuthorization: vi.fn(async (_account: unknown, opts: { to: string; units: bigint }) => ({ from: "0xcustodial", to: opts.to, value: opts.units })),
    relayUsdgAuthorization: vi.fn(async () => {
      if (!state.transferOk) throw new Error("rpc down");
      return "0x" + "b2".repeat(32);
    }),
    custodialEthBalance: vi.fn(async () => state.ethBalance),
    custodialUsdgBalance: vi.fn(async () => state.usdgBalance),
    custodialAccount: vi.fn(() => ({ address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA" })),
    writeAudit: vi.fn(async () => undefined),
    aggregate: vi.fn(async ({ where }: { where: { account: string } }) => ({
      _sum: { deltaMicros: ledger.filter((e) => e.account === where.account).reduce((a, e) => a + e.deltaMicros, 0n) },
    })),
    ledgerCreate: vi.fn(async ({ data }: { data: Omit<LedgerRow, "id"> }) => {
      const row: LedgerRow = { id: `led_${++seq}`, ...data };
      (data.account === "TREASURY" ? treasuryEntries : ledger).push(row);
      return row;
    }),
    ledgerDelete: vi.fn(async ({ where }: { where: { id: string } }) => {
      const i = ledger.findIndex((e) => e.id === where.id);
      if (i >= 0) ledger.splice(i, 1);
      return {};
    }),
    ledgerUpdate: vi.fn(async () => ({})),
    dailyUpsert: vi.fn(async () => ({})),
    dailyUpdateMany: vi.fn(async ({ where, data }: { where: { usedMicros?: { lte: bigint } }; data: { usedMicros: { increment?: bigint; decrement?: bigint } } }) => {
      const inc = data.usedMicros.increment;
      const dec = data.usedMicros.decrement;
      if (inc !== undefined) {
        const lte = where.usedMicros?.lte;
        if (lte !== undefined && state.dailyUsed > lte) return { count: 0 };
        state.dailyUsed += inc;
        return { count: 1 };
      }
      if (dec !== undefined) {
        state.dailyUsed -= dec;
        return { count: 1 };
      }
      return { count: 0 };
    }),
    dailyFindUnique: vi.fn(async () => ({ usedMicros: state.dailyUsed })),
  };
});

vi.mock("@pyre/db", () => ({
  prisma: {
    ledgerEntry: { create: fx.ledgerCreate, delete: fx.ledgerDelete, update: fx.ledgerUpdate },
    dailyWithdraw: { upsert: fx.dailyUpsert, updateMany: fx.dailyUpdateMany, findUnique: fx.dailyFindUnique },
  },
}));
vi.mock("@pyre/chain", () => ({
  getEthPriceUsd: fx.getEthPriceUsd,
  transferEth: fx.transferEth,
  signUsdgAuthorization: fx.signUsdgAuthorization,
  relayUsdgAuthorization: fx.relayUsdgAuthorization,
  getErc20Balance: async () => 0n,
  explorerTxUrl: (h: string) => `https://explorer.test/tx/${h}`,
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: { address: "0x0000000000000000000000000000000000000001" } }),
}));
vi.mock("../src/lib/metrics.js", () => ({ db: { ledgerEntry: { aggregate: fx.aggregate } } }));
vi.mock("../src/lib/cache.js", () => ({ cached: <T,>(_k: unknown, _ttl: unknown, fn: () => Promise<T>) => fn() }));
vi.mock("../src/lib/custodial.js", () => ({
  custodialAccount: fx.custodialAccount,
  custodialEthBalance: fx.custodialEthBalance,
  custodialUsdgBalance: fx.custodialUsdgBalance,
  GAS_RESERVE_WEI: 20_000_000_000_000n,
}));
vi.mock("../src/lib/audit.js", () => ({ writeAudit: fx.writeAudit }));
vi.mock("../src/lib/launch.js", () => ({ launchesLast24h: async () => 0 }));
vi.mock("../src/lib/trade.js", () => ({ executeTrade: vi.fn(), quoteTrade: vi.fn(), recordTrade: vi.fn() }));
vi.mock("../src/lib/dto.js", () => ({
  usd: (m: bigint) => Number(m) / 1e6,
  tokens: (t: bigint) => Number(t) / 1e18,
  pctOfSupply: () => 0,
  appSummary: () => ({}),
  appExtrasByApp: async () => ({}),
  launchDto: () => ({}),
  tradeDto: () => ({}),
  APP_SUMMARY_SELECT: {},
}));

import { claimHandler, withdrawHandler } from "../src/routes/me.js";

interface TestUser {
  id: string;
  wallet: string | null;
  walletIndex: number;
  reputation: number;
}
const USER: TestUser = { id: "u1", wallet: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", walletIndex: 5, reputation: 0 };
const req = (body: Record<string, unknown> = {}, user: TestUser = USER): Request => ({ body, user }) as unknown as Request;
const res = (): { r: Response; c: { status: number; body: unknown } } => {
  const c = { status: 200, body: undefined as unknown };
  const r = {
    status(code: number) {
      c.status = code;
      return r;
    },
    json(p: unknown) {
      c.body = p;
      return r;
    },
    setHeader() {
      return r;
    },
  } as unknown as Response;
  return { r, c };
};
const balance = (): bigint => fx.ledger.filter((e) => e.account === "LAUNCHER:u1").reduce((a, e) => a + e.deltaMicros, 0n);

beforeEach(() => {
  fx.ledger.length = 0;
  fx.treasuryEntries.length = 0;
  fx.state.ethPriceUsd = 2000;
  fx.state.transferOk = true;
  fx.state.ethBalance = 0n;
  fx.state.usdgBalance = 0n;
  fx.state.dailyUsed = 0n;
  for (const f of [fx.transferEth, fx.signUsdgAuthorization, fx.relayUsdgAuthorization, fx.writeAudit, fx.ledgerCreate, fx.ledgerDelete, fx.ledgerUpdate, fx.aggregate, fx.dailyUpsert, fx.dailyUpdateMany, fx.dailyFindUnique]) f.mockClear();
});

describe("claim (fee payout)", () => {
  it("pays out the full LAUNCHER balance in ETH at the current price, zeroes the ledger, and debits the treasury once", async () => {
    fx.ledger.push({ id: "seed", account: "LAUNCHER:u1", deltaMicros: 5_000_000n }); // $5 accrued at $2000/ETH = 0.0025 ETH
    const { r, c } = res();
    await claimHandler(req(), r);

    expect(balance()).toBe(0n);
    expect(fx.transferEth).toHaveBeenCalledTimes(1);
    expect(fx.transferEth.mock.calls[0]?.[1]).toBe(USER.wallet);
    expect(fx.transferEth.mock.calls[0]?.[2]).toBe(2_500_000_000_000_000n);
    expect(fx.treasuryEntries).toHaveLength(1);
    expect(fx.treasuryEntries[0]).toMatchObject({ deltaMicros: -5_000_000n });
    expect(c.body).toMatchObject({ usdMicros: "5000000", wei: "2500000000000000", txHash: "0x" + "a1".repeat(32) });
  });

  it("rolls the clearing entry back and pays nothing when the payout transfer fails", async () => {
    fx.ledger.push({ id: "seed", account: "LAUNCHER:u1", deltaMicros: 5_000_000n });
    fx.state.transferOk = false;
    const { r } = res();
    await expect(claimHandler(req(), r)).rejects.toMatchObject({ status: 502 });
    expect(balance()).toBe(5_000_000n);
    expect(fx.treasuryEntries).toHaveLength(0);
  });

  it("rejects a claim below the $1 floor without touching the ledger or treasury", async () => {
    fx.ledger.push({ id: "seed", account: "LAUNCHER:u1", deltaMicros: 500_000n }); // $0.50
    const { r } = res();
    await expect(claimHandler(req(), r)).rejects.toMatchObject({ status: 400, message: "nothing_to_claim" });
    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(balance()).toBe(500_000n);
  });

  it("aborts as claim_in_progress when a concurrent claim already cleared the balance", async () => {
    fx.ledger.push({ id: "seed", account: "LAUNCHER:u1", deltaMicros: 5_000_000n });
    fx.aggregate
      .mockImplementationOnce(async () => ({ _sum: { deltaMicros: 5_000_000n } }))
      .mockImplementationOnce(async () => ({ _sum: { deltaMicros: -5_000_000n } }));
    const { r } = res();
    await expect(claimHandler(req(), r)).rejects.toMatchObject({ status: 409, message: "claim_in_progress" });
    expect(fx.transferEth).not.toHaveBeenCalled();
  });

  it("requires a wallet on the account", async () => {
    const { r } = res();
    await expect(claimHandler(req({}, { ...USER, wallet: null }), r)).rejects.toMatchObject({ status: 400, message: "wallet_required" });
  });
});

describe("withdraw (custodial payout)", () => {
  const DEST = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

  it("server-signs an ETH transfer when the balance covers amount + gas reserve", async () => {
    fx.state.ethBalance = 200_000_000_000_000_000n; // 0.2 ETH
    const { r, c } = res();
    await withdrawHandler(req({ asset: "ETH", to: DEST, amount: 0.1 }), r);
    expect(fx.transferEth).toHaveBeenCalledTimes(1);
    expect(fx.transferEth.mock.calls[0]?.[1]).toBe(DEST);
    expect(fx.transferEth.mock.calls[0]?.[2]).toBe(100_000_000_000_000_000n);
    expect(fx.writeAudit).toHaveBeenCalledTimes(1);
    expect(c.body).toMatchObject({ asset: "ETH", amount: "100000000000000000", txHash: "0x" + "a1".repeat(32) });
    // $200 at $2000/ETH reserved against the daily cap.
    expect(fx.state.dailyUsed).toBe(200_000_000n);
  });

  it("blocks an ETH withdraw that would leave nothing for gas", async () => {
    fx.state.ethBalance = 100_000_000_000_000_000n; // exactly the amount, no gas headroom
    const { r, c } = res();
    await expect(withdrawHandler(req({ asset: "ETH", to: DEST, amount: 0.1 }), r)).rejects.toMatchObject({ status: 400, message: "insufficient_balance" });
    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(c.body).toBeUndefined();
  });

  it("relays a USDG EIP-3009 authorization through the treasury even when the wallet holds no ETH", async () => {
    fx.state.ethBalance = 0n;
    fx.state.usdgBalance = 10_000_000n; // $10
    const { r, c } = res();
    await withdrawHandler(req({ asset: "USDG", to: DEST, amount: 5 }), r);
    expect(fx.signUsdgAuthorization).toHaveBeenCalledTimes(1);
    expect(fx.signUsdgAuthorization.mock.calls[0]?.[1]).toMatchObject({ to: DEST, units: 5_000_000n });
    expect(fx.relayUsdgAuthorization).toHaveBeenCalledTimes(1);
    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(c.body).toMatchObject({ asset: "USDG", amount: "5000000", txHash: "0x" + "b2".repeat(32) });
    expect(fx.state.dailyUsed).toBe(5_000_000n);
  });

  it("blocks a USDG withdraw larger than the token balance", async () => {
    fx.state.usdgBalance = 1_000_000n; // $1
    const { r } = res();
    await expect(withdrawHandler(req({ asset: "USDG", to: DEST, amount: 5 }), r)).rejects.toMatchObject({ status: 400, message: "insufficient_balance" });
    expect(fx.relayUsdgAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a withdraw that would breach the daily USD cap, before any transfer", async () => {
    fx.state.usdgBalance = 3_000_000_000n; // $3000 on hand
    fx.state.dailyUsed = 24_000_000_000n; // $24k already withdrawn today
    const { r } = res();
    await expect(withdrawHandler(req({ asset: "USDG", to: DEST, amount: 2000 }), r)).rejects.toMatchObject({
      status: 400,
      message: "daily_limit_exceeded",
    });
    expect(fx.relayUsdgAuthorization).not.toHaveBeenCalled();
    expect(fx.writeAudit).not.toHaveBeenCalled();
  });

  it("releases the daily reservation when the on-chain transfer fails, so a retry isn't blocked", async () => {
    fx.state.ethBalance = 200_000_000_000_000_000n;
    fx.state.transferOk = false;
    const { r } = res();
    await expect(withdrawHandler(req({ asset: "ETH", to: DEST, amount: 0.1 }), r)).rejects.toMatchObject({ status: 502 });
    expect(fx.state.dailyUsed).toBe(0n); // reserved then released — nothing consumed
    expect(fx.writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a malformed destination address", async () => {
    fx.state.ethBalance = 200_000_000_000_000_000n;
    const { r } = res();
    await expect(withdrawHandler(req({ asset: "ETH", to: "0x5fc5360d0400a0fd4f2af552add042d716f1D168", amount: 0.1 }), r)).rejects.toMatchObject({ status: 400, message: "validation_failed" });
    expect(fx.transferEth).not.toHaveBeenCalled();
  });

  it("refuses a withdraw to the user's own custodial wallet", async () => {
    fx.state.ethBalance = 200_000_000_000_000_000n;
    const { r } = res();
    await expect(withdrawHandler(req({ asset: "ETH", to: USER.wallet, amount: 0.1 }), r)).rejects.toMatchObject({ status: 400, message: "cannot_withdraw_to_self" });
  });
});
