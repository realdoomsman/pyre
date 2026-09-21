import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostContext } from "../src/host/resolve.js";

/**
 * Custodial checkout: `POST /_pyre/checkout` charges the price in USDG on Robinhood Chain from the
 * caller's platform-held wallet — an EIP-3009 authorization signed server-side, relayed by the
 * treasury (the user needs no ETH) — and records the paid purchase. The money-critical decisions are
 * pinned with fakes (prisma, chain, custodial account, session, revenue): 402 with the deposit
 * address on insufficient USDG, exactly-once revenue keyed on the mined hash, and a FAILED purchase
 * (never PAID, never revenue) when the relay throws or the receipt does not carry the full amount.
 */

interface PurchaseRow {
  id: string;
  appId: string;
  userId: string;
  productId: string;
  kind: "ONE_OFF" | "SUBSCRIPTION_MONTHLY";
  usdMicros: bigint;
  status: "PENDING" | "PAID" | "REFUNDED" | "FAILED";
  txHash: string | null;
  paidAt: Date | null;
  expiresAt: Date | null;
  payerWallet: string;
}

const PAYER = "0x1111111111111111111111111111111111111111";
const TREASURY = "0x2222222222222222222222222222222222222222";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TX = "0xabc0000000000000000000000000000000000000000000000000000000000001";

/** Hoisted so the `vi.mock` factories (which run before module init) can close over them. */
const fixtures = vi.hoisted(() => {
  const purchases: Array<Record<string, unknown>> = [];
  const sessionUser: { id: string; wallet: string | null; walletIndex: number } = {
    id: "user_1",
    wallet: "0x1111111111111111111111111111111111111111",
    walletIndex: 7,
  };
  const balances = { usdgUnits: 100_000_000n };
  const account = { address: "0x1111111111111111111111111111111111111111" };
  const dailyCharges: Record<string, bigint> = {};
  return {
    purchases,
    dailyCharges,
    sessionUser,
    balances,
    account,
    custodialUsdgBalance: vi.fn(async () => balances.usdgUnits),
    signUsdgAuthorization: vi.fn(async (_account: unknown, opts: { to: string; units: bigint; validBefore: bigint }) => ({
      from: account.address,
      to: opts.to,
      value: opts.units,
      validAfter: 0n,
      validBefore: opts.validBefore,
      nonce: "0x" + "11".repeat(32),
      v: 27,
      r: "0x" + "22".repeat(32),
      s: "0x" + "33".repeat(32),
    })),
    relayUsdgAuthorization: vi.fn(async () => "0xabc0000000000000000000000000000000000000000000000000000000000001"),
    verifyErc20Transfer: vi.fn(async (_hash: string, opts: { minUnits: bigint }) => ({
      ok: true,
      from: account.address,
      units: opts.minUnits,
    })),
    recordRevenue: vi.fn(async (_input: Record<string, unknown>): Promise<void> => undefined),
    currentUser: vi.fn(async () => sessionUser as typeof sessionUser | null),
    custodialAccount: vi.fn(() => account),
  };
});

const purchases = fixtures.purchases as unknown as PurchaseRow[];
const {
  sessionUser,
  balances,
  custodialUsdgBalance,
  signUsdgAuthorization,
  relayUsdgAuthorization,
  verifyErc20Transfer,
  recordRevenue,
  currentUser,
  custodialAccount,
} = fixtures;

vi.mock("@pyre/db", () => ({
  prisma: {
    // `lib/metrics.ts` wraps prisma with a timing extension at import time.
    $extends: () => ({}),
    purchase: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const rows = fixtures.purchases as unknown as PurchaseRow[];
        const id = `pur_${rows.length + 1}`;
        rows.push({ id, ...(data as object) } as PurchaseRow);
        return { id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<PurchaseRow> }) => {
        const row = (fixtures.purchases as unknown as PurchaseRow[]).find((p) => p.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? ({ id: where.id } as PurchaseRow);
      },
    },
    // Per-user, per-app, per-day charge total: the same conditional-increment contract as Postgres.
    dailyAppCharge: {
      upsert: async ({ where }: { where: { userId_appId_day: { userId: string; appId: string; day: string } } }) => {
        const k = where.userId_appId_day;
        const id = `${k.userId}|${k.appId}|${k.day}`;
        fixtures.dailyCharges[id] ??= 0n;
        return { ...k, usedMicros: fixtures.dailyCharges[id] };
      },
      updateMany: async ({ where, data }: { where: { userId: string; appId: string; day: string; usedMicros?: { lte: bigint } }; data: { usedMicros: { increment?: bigint; decrement?: bigint } } }) => {
        const id = `${where.userId}|${where.appId}|${where.day}`;
        const used = fixtures.dailyCharges[id] ?? 0n;
        if (where.usedMicros && used > where.usedMicros.lte) return { count: 0 };
        fixtures.dailyCharges[id] = used + (data.usedMicros.increment ?? 0n) - (data.usedMicros.decrement ?? 0n);
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { userId_appId_day: { userId: string; appId: string; day: string } } }) => {
        const k = where.userId_appId_day;
        return { ...k, usedMicros: fixtures.dailyCharges[`${k.userId}|${k.appId}|${k.day}`] ?? 0n };
      },
    },
  },
}));
vi.mock("@pyre/chain", () => ({
  usdgAddress: () => "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  signUsdgAuthorization: fixtures.signUsdgAuthorization,
  relayUsdgAuthorization: fixtures.relayUsdgAuthorization,
  verifyErc20Transfer: fixtures.verifyErc20Transfer,
}));
vi.mock("../src/lib/custodial.js", () => ({
  custodialAccount: fixtures.custodialAccount,
  custodialUsdgBalance: fixtures.custodialUsdgBalance,
}));
vi.mock("../src/lib/treasury.js", () => ({ TREASURY_WALLET: "0x2222222222222222222222222222222222222222" }));
vi.mock("../src/lib/redis.js", () => ({
  redis: { get: async () => null, set: async () => "OK", del: async () => 1 },
  subscribeChannel: () => () => undefined,
  closeRedis: async () => undefined,
}));
vi.mock("../src/host/session.js", () => ({ currentUser: fixtures.currentUser, sessionCookieName: "pyre_session" }));
vi.mock("../src/host/revenue.js", () => ({ recordRevenue: fixtures.recordRevenue }));

import { checkoutStart } from "../src/host/routes/checkout.js";

const ctx = (products: Array<{ id: string; kind: string; priceUsd: number }> = []): HostContext =>
  ({
    app: { id: "app_1", slug: "demo" },
    deployment: { id: "dep_1", version: 1, manifest: { products } },
    basePath: "/a/demo",
    origin: "https://api.pyre.test",
  }) as unknown as HostContext;

/** Minimal express Request: `readJson` iterates the stream, `currentUser` is faked. */
const request = (body: unknown): Request => {
  const json = JSON.stringify(body);
  const stream = Readable.from([Buffer.from(json, "utf8")]) as unknown as Request;
  stream.headers = { "content-length": String(Buffer.byteLength(json)) };
  return stream;
};

interface Captured {
  status: number;
  body: unknown;
}

const response = (): { res: Response; captured: Captured } => {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
      return res;
    },
    setHeader: () => res,
  } as unknown as Response;
  return { res, captured };
};

const ONE_OFF = [{ id: "pro", kind: "ONE_OFF", priceUsd: 5 }];

beforeEach(() => {
  purchases.length = 0;
  for (const k of Object.keys(fixtures.dailyCharges)) delete fixtures.dailyCharges[k];
  sessionUser.id = "user_1";
  sessionUser.wallet = PAYER;
  balances.usdgUnits = 100_000_000n;
  custodialUsdgBalance.mockClear();
  signUsdgAuthorization.mockClear();
  relayUsdgAuthorization.mockClear();
  verifyErc20Transfer.mockClear();
  recordRevenue.mockClear();
  currentUser.mockClear();
  custodialAccount.mockClear();
});

describe("checkoutStart (custodial USDG)", () => {
  it("signs a USDG authorization from the payer's wallet, relays it, and records the paid purchase exactly once", async () => {
    const { res, captured } = response();
    const before = Math.floor(Date.now() / 1000);
    await checkoutStart(ctx(ONE_OFF), request({ productId: "pro" }), res);

    expect(custodialUsdgBalance).toHaveBeenCalledWith(PAYER);
    expect(custodialAccount).toHaveBeenCalledWith(sessionUser);
    expect(signUsdgAuthorization).toHaveBeenCalledTimes(1);
    const [account, opts] = signUsdgAuthorization.mock.calls[0]!;
    expect(account).toBe(fixtures.account);
    expect(opts).toMatchObject({ to: TREASURY, units: 5_000_000n });
    // The authorization is short-lived: minutes, not days.
    expect(Number(opts.validBefore)).toBeGreaterThan(before);
    expect(Number(opts.validBefore)).toBeLessThanOrEqual(before + 11 * 60);
    expect(relayUsdgAuthorization).toHaveBeenCalledWith(await signUsdgAuthorization.mock.results[0]!.value);
    expect(verifyErc20Transfer).toHaveBeenCalledWith(TX, { token: USDG, to: TREASURY, minUnits: 5_000_000n });

    expect(purchases[0]).toMatchObject({ status: "PAID", txHash: TX, payerWallet: PAYER, usdMicros: 5_000_000n });
    expect(recordRevenue).toHaveBeenCalledTimes(1);
    expect(recordRevenue.mock.calls[0]?.[0]).toMatchObject({
      source: "CHECKOUT",
      usdMicros: 5_000_000n,
      payer: PAYER,
      reference: TX,
      purchaseId: "pur_1",
    });
    expect(captured.body).toEqual({ ok: true, purchase: { status: "PAID", expiresAt: null, txHash: TX } });
  });

  it("sets a 30-day expiry and SUBSCRIPTION revenue for a monthly product", async () => {
    const { res, captured } = response();
    await checkoutStart(ctx([{ id: "sub", kind: "SUBSCRIPTION_MONTHLY", priceUsd: 9 }]), request({ productId: "sub" }), res);

    const body = captured.body as { ok: boolean; purchase: { status: string; expiresAt: Date | null } };
    expect(body.purchase.status).toBe("PAID");
    const expiry = body.purchase.expiresAt?.getTime() ?? 0;
    expect(expiry).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(expiry).toBeLessThan(Date.now() + 31 * 86_400_000);
    expect(recordRevenue.mock.calls[0]?.[0]).toMatchObject({ source: "SUBSCRIPTION", usdMicros: 9_000_000n });
  });

  it("returns 402 with the deposit address, without signing, when USDG is short", async () => {
    balances.usdgUnits = 4_999_999n;
    const { res, captured } = response();
    await checkoutStart(ctx(ONE_OFF), request({ productId: "pro" }), res);

    expect(captured.status).toBe(402);
    expect(captured.body).toEqual({ error: "insufficient_funds", priceUsd: 5, balanceUsd: 4.999999, depositAddress: PAYER });
    expect(signUsdgAuthorization).not.toHaveBeenCalled();
    expect(relayUsdgAuthorization).not.toHaveBeenCalled();
    expect(recordRevenue).not.toHaveBeenCalled();
    expect(purchases).toHaveLength(0);
  });

  it("never gates on ETH: a wallet holding only USDG pays", async () => {
    // The treasury relays the authorization and pays gas; the only balance read is USDG.
    const { res, captured } = response();
    await checkoutStart(ctx(ONE_OFF), request({ productId: "pro" }), res);
    expect(captured.status).toBe(200);
    expect(custodialUsdgBalance).toHaveBeenCalledTimes(1);
  });

  it("marks the purchase FAILED and never records revenue when the relay throws", async () => {
    relayUsdgAuthorization.mockRejectedValueOnce(new Error("rpc down"));
    const { res } = response();
    await expect(checkoutStart(ctx(ONE_OFF), request({ productId: "pro" }), res)).rejects.toMatchObject({ status: 502 });
    expect(purchases[0]).toMatchObject({ status: "FAILED" });
    expect(recordRevenue).not.toHaveBeenCalled();
  });

  it("marks the purchase FAILED when the mined receipt does not carry the full amount to the treasury", async () => {
    verifyErc20Transfer.mockResolvedValueOnce({ ok: false, from: PAYER, units: 1n });
    const { res } = response();
    await expect(checkoutStart(ctx(ONE_OFF), request({ productId: "pro" }), res)).rejects.toMatchObject({ status: 502 });
    expect(purchases[0]).toMatchObject({ status: "FAILED" });
    expect(recordRevenue).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    currentUser.mockResolvedValueOnce(null);
    const { res } = response();
    await expect(checkoutStart(ctx(ONE_OFF), request({ productId: "pro" }), res)).rejects.toMatchObject({ status: 401 });
    expect(signUsdgAuthorization).not.toHaveBeenCalled();
  });

  it("rejects an unknown product before touching the wallet", async () => {
    const { res } = response();
    await expect(checkoutStart(ctx(ONE_OFF), request({ productId: "nope" }), res)).rejects.toMatchObject({ status: 404 });
    expect(custodialUsdgBalance).not.toHaveBeenCalled();
  });

  it("refuses a single charge above the platform ceiling with 402 charge_limit, before any signing", async () => {
    // The manifest schema rejects such a product, but the host must not trust the manifest alone.
    balances.usdgUnits = 1_000_000_000_000n;
    const { res } = response();
    await expect(checkoutStart(ctx([{ id: "whale", kind: "ONE_OFF", priceUsd: 250.01 }]), request({ productId: "whale" }), res)).rejects.toMatchObject({
      status: 402,
      message: "charge_limit",
      extra: { reason: "single", maxChargeUsd: 250 },
    });
    expect(signUsdgAuthorization).not.toHaveBeenCalled();
    expect(purchases).toHaveLength(0);
  });

  it("caps what one app can charge one user per day at $1,000 and releases the reservation when payment fails", async () => {
    balances.usdgUnits = 1_000_000_000_000n;
    const products = [{ id: "big", kind: "ONE_OFF", priceUsd: 250 }];
    for (let i = 0; i < 4; i++) await checkoutStart(ctx(products), request({ productId: "big" }), response().res);
    expect(recordRevenue).toHaveBeenCalledTimes(4);

    // $1,000 spent today with this app: the fifth charge is refused, whatever the balance.
    await expect(checkoutStart(ctx(products), request({ productId: "big" }), response().res)).rejects.toMatchObject({
      status: 402,
      message: "charge_limit",
      extra: { reason: "daily", dailyCapUsd: 1000, usedTodayUsd: 1000 },
    });
    expect(signUsdgAuthorization).toHaveBeenCalledTimes(4);

    // Another app has its own budget with this user.
    const other = { ...ctx(products), app: { id: "app_2", slug: "other" } } as unknown as HostContext;
    await checkoutStart(other, request({ productId: "big" }), response().res);
    expect(recordRevenue).toHaveBeenCalledTimes(5);

    // A failed relay gives the reservation back: the user is not "charged" for money that never moved.
    relayUsdgAuthorization.mockRejectedValueOnce(new Error("rpc down"));
    await expect(checkoutStart(other, request({ productId: "big" }), response().res)).rejects.toMatchObject({ status: 502 });
    expect(fixtures.dailyCharges[`user_1|app_2|${new Date().toISOString().slice(0, 10)}`]).toBe(250_000_000n);
  });
});
