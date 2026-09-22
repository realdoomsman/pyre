import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dec, type Prisma } from "@pyre/db";

/**
 * The three custodial "money-in" flows: each one server-signs a transfer OUT of the caller's
 * platform wallet, then writes the matching accounting row. The load-bearing parts are (1) the
 * balance gate must block a transfer the chain would reject (amount + gas reserve), (2) the balance
 * gate must run BEFORE any record is written, and (3) the domain gates ($PYRE launched? app live?
 * bounty large enough?) that decide whether the flow is even allowed. Everything below HTTP is
 * faked, so these assert pure decision logic and the exact transfer/record pair each path produces.
 */

type AppRow = {
  id: string;
  slug: string;
  name: string;
  ticker: string;
  status: string;
  chain: "robinhood" | "solana";
  launchpad: "pons_v2" | "pump_fun";
  walletAddress: string | null;
  budgetMicros: bigint;
  /** Wei columns are `Decimal(78, 0)`; the handler must write `Prisma.Decimal`, never bigint. */
  feesWei: Prisma.Decimal;
};
type Row = Record<string, unknown>;
type CreateArgs = { data: Row };
type AppUpdateArgs = {
  data: { budgetMicros?: { increment?: bigint }; feesWei?: { increment?: Prisma.Decimal }; status?: string };
};
type TxClient = {
  feeEvent: { create: (a: CreateArgs) => Promise<Row> };
  ledgerEntry: { create: (a: CreateArgs) => Promise<Row> };
  bounty: { create: (a: CreateArgs) => Promise<Row> };
  app: { update: (a: AppUpdateArgs) => Promise<AppRow> };
};

const TREASURY = "0x0000000000000000000000000000000000000001";
const PYRE_TOKEN = "0x1111111111111111111111111111111111111111";
const APP_WALLET = "0x2222222222222222222222222222222222222222";
const GAS_RESERVE_WEI = 20_000_000_000_000n;

const fx = vi.hoisted(() => {
  const state = {
    pyreToken: "0x1111111111111111111111111111111111111111" as string | undefined,
    ethPriceUsd: 2000,
    solPriceUsd: 120,
    transferOk: true,
    ethBalance: 0n,
    solBalance: 0n,
    tokenBalance: 0n,
  };
  const app: { current: AppRow | null } = { current: null };
  const pyreStakes: Row[] = [];
  const bounties: Row[] = [];
  const feeEvents: Row[] = [];
  const ledgerEntries: Row[] = [];
  const appUpdates: AppRow[] = [];
  let seq = 0;
  return {
    state,
    app,
    pyreStakes,
    bounties,
    feeEvents,
    ledgerEntries,
    appUpdates,
    transferEth: vi.fn(async (_from: unknown, _to: string, _wei: bigint) => {
      if (!state.transferOk) throw new Error("rpc down");
      return "0x" + "e1".repeat(32);
    }),
    transferErc20: vi.fn(async (_from: unknown, _token: string, _to: string, _units: bigint) => {
      if (!state.transferOk) throw new Error("rpc down");
      return "0x" + "e2".repeat(32);
    }),
    getEthPriceUsd: vi.fn(async () => state.ethPriceUsd),
    custodialEthBalance: vi.fn(async () => state.ethBalance),
    pyreBalance: vi.fn(async () => state.tokenBalance),
    custodialAccount: vi.fn(() => ({ address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA" })),
    transferSol: vi.fn(async (_from: unknown, _to: string, _lamports: bigint) => {
      if (!state.transferOk) throw new Error("rpc down");
      return { hash: "5wHu1qwD4E3vTd9nJqvUeYtWuDL1yiLFJVXDQzVdYc3PtLHRZAx9y1n2Cz3wVn3nS4eZfLPaJRBk6eZB4bHzAYS", block: 1 };
    }),
    writeAudit: vi.fn(async () => undefined),
    publishEvent: vi.fn(async () => undefined),
    publishGlobal: vi.fn(async () => undefined),
    appFindUnique: vi.fn(async () => app.current),
    pyreStakeCreate: vi.fn(async ({ data }: CreateArgs): Promise<Row> => {
      const row = { id: `stake_${++seq}`, earnedMicros: 0n, withdrawTx: null, withdrawnAt: null, createdAt: new Date(0), ...data };
      pyreStakes.push(row);
      return row;
    }),
    bountyCreate: vi.fn(async ({ data }: CreateArgs): Promise<Row> => {
      const row = { id: `bounty_${++seq}`, ...data };
      bounties.push(row);
      return row;
    }),
    feeEventCreate: vi.fn(async ({ data }: CreateArgs): Promise<Row> => {
      const row = { id: `fee_${++seq}`, ...data };
      feeEvents.push(row);
      return row;
    }),
    ledgerCreate: vi.fn(async ({ data }: CreateArgs): Promise<Row> => {
      const row = { id: `led_${++seq}`, ...data };
      ledgerEntries.push(row);
      return row;
    }),
    appUpdate: vi.fn(async ({ data }: AppUpdateArgs): Promise<AppRow> => {
      const base = app.current!;
      const result: AppRow = {
        ...base,
        budgetMicros: base.budgetMicros + (data.budgetMicros?.increment ?? 0n),
        feesWei: data.feesWei?.increment ? base.feesWei.add(data.feesWei.increment) : base.feesWei,
        status: data.status ?? base.status,
      };
      appUpdates.push(result);
      return result;
    }),
  };
});

vi.mock("@pyre/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prisma: {
    app: { findUnique: fx.appFindUnique, update: fx.appUpdate },
    pyreStake: { create: fx.pyreStakeCreate },
    bounty: { create: fx.bountyCreate },
    feeEvent: { create: fx.feeEventCreate, findUnique: vi.fn(async () => null) },
    ledgerEntry: { create: fx.ledgerCreate },
    $transaction: async <T>(fn: (tx: TxClient) => Promise<T>): Promise<T> =>
      fn({
        feeEvent: { create: fx.feeEventCreate },
        ledgerEntry: { create: fx.ledgerCreate },
        app: { update: fx.appUpdate },
        bounty: { create: fx.bountyCreate },
      }),
  },
}));
/**
 * Venue adapters: the PONS one signs with the same `transferEth`/balance fakes the other flows use
 * (so a top-up on Robinhood is provably the same transfer as before); the pump one signs SOL.
 */
vi.mock("@pyre/chain", () => ({
  transferEth: fx.transferEth,
  transferErc20: fx.transferErc20,
  getEthPriceUsd: fx.getEthPriceUsd,
  getErc20Balance: async () => 0n,
  explorerTxUrl: (h: string) => `https://explorer.test/tx/${h}`,
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: { address: "0x0000000000000000000000000000000000000001" } }),
  solanaEnabled: () => true,
  adapterFor: (launchpad: string) =>
    launchpad === "pons_v2"
      ? {
          info: { chain: "robinhood", launchpad: "pons_v2", native: { symbol: "ETH", decimals: 18 } },
          userWallet: () => ({ chain: "robinhood", address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", signer: fx.custodialAccount() }),
          nativeBalance: fx.custodialEthBalance,
          nativePriceUsd: fx.getEthPriceUsd,
          transferNative: async (from: { signer: unknown }, to: string, wei: bigint) => ({ hash: await fx.transferEth(from.signer, to, wei), block: 1 }),
        }
      : {
          info: { chain: "solana", launchpad: "pump_fun", native: { symbol: "SOL", decimals: 9 } },
          userWallet: () => ({ chain: "solana", address: "So1anaUser111111111111111111111111111111111", signer: {} }),
          nativeBalance: async () => fx.state.solBalance,
          nativePriceUsd: async () => fx.state.solPriceUsd,
          transferNative: fx.transferSol,
        },
}));
vi.mock("../src/lib/custodial.js", () => ({
  custodialAccount: fx.custodialAccount,
  custodialEthBalance: fx.custodialEthBalance,
  custodialUsdgBalance: vi.fn(),
  GAS_RESERVE_WEI: 20_000_000_000_000n,
  GAS_RESERVE_BY_CHAIN: { robinhood: 20_000_000_000_000n, solana: 2_000_000n },
}));
vi.mock("../src/lib/votes.js", () => ({
  pyreBalance: fx.pyreBalance,
  PLATFORM_PROPOSAL_MIN_HOLD: 0n,
  SUPPLY_BASE_UNITS: 10n ** 27n,
}));
vi.mock("../src/lib/market.js", () => ({ marketSnapshot: async () => null }));
vi.mock("../src/lib/audit.js", () => ({ writeAudit: fx.writeAudit }));
vi.mock("../src/lib/events.js", () => ({
  publishEvent: fx.publishEvent,
  publishGlobal: fx.publishGlobal,
  GLOBAL_FEED_CHANNEL: "feed:*global*",
}));
vi.mock("../src/lib/redis.js", () => ({
  redis: { publish: vi.fn(async () => 0) },
  subscribeChannel: vi.fn(async () => () => undefined),
}));
vi.mock("../src/lib/cache.js", () => ({
  APPS_TAG: "apps",
  appTag: (id: string) => `app:${id}`,
  cacheKey: (...p: unknown[]) => p.join(":"),
  cached: async (_k: unknown, _t: unknown, fn: () => unknown) => fn(),
}));
vi.mock("../src/lib/metrics.js", () => ({
  db: { ledgerEntry: { aggregate: vi.fn() } },
  sseConnections: { add: vi.fn() },
}));
vi.mock("../src/lib/dto.js", () => ({
  usd: (m: bigint) => Number(m) / 1e6,
  tokens: (t: bigint) => Number(t) / 1e18,
  pctOfSupply: () => 0,
  bountyDto: (b: unknown) => b,
  stakeDto: (s: unknown) => s,
  appSummary: () => ({}),
  appExtrasByApp: async () => ({}),
  candleDto: () => ({}),
  eventDto: () => ({}),
  feeEventDto: () => ({}),
  holderDto: () => ({}),
  jobDto: () => ({}),
  prDto: () => ({}),
  queueItemDto: () => ({}),
  tradeDto: () => ({}),
  userRef: () => ({}),
  APP_SUMMARY_SELECT: {},
  USER_REF_SELECT: {},
}));
// Real env is fully populated by vitest.config, but PYRE_TOKEN is frozen at import; proxy it so the
// `pyre_not_launched` gate can be exercised with the token unset.
vi.mock("../src/env.js", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, p) => (p === "PYRE_TOKEN" ? fx.state.pyreToken : t[p as string]),
    }),
  };
});

import { pyreStakeHandler } from "../src/routes/pyre.js";
import { topupHandler } from "../src/routes/apps.js";
import { createBountyHandler } from "../src/routes/bounties.js";

const USER = { id: "u1", wallet: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", walletIndex: 5, reputation: 0 };
const req = (opts: { body?: unknown; params?: Record<string, string>; user?: unknown } = {}) =>
  ({ body: opts.body ?? {}, params: opts.params ?? {}, user: opts.user ?? USER }) as unknown as Request;
const res = () => {
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

const liveApp = (): AppRow => ({
  id: "app1",
  slug: "cool",
  name: "Cool",
  ticker: "COOL",
  status: "LIVE",
  chain: "robinhood",
  launchpad: "pons_v2",
  walletAddress: APP_WALLET,
  budgetMicros: 0n,
  feesWei: dec(0),
});

const SOL_APP_WALLET = "AppWa11et111111111111111111111111111111111";
const solApp = (): AppRow => ({ ...liveApp(), id: "app2", slug: "solcool", chain: "solana", launchpad: "pump_fun", walletAddress: SOL_APP_WALLET });

const ETH = 10n ** 18n;

beforeEach(() => {
  fx.state.pyreToken = PYRE_TOKEN;
  fx.state.ethPriceUsd = 2000;
  fx.state.transferOk = true;
  fx.state.ethBalance = 0n;
  fx.state.solBalance = 0n;
  fx.state.tokenBalance = 0n;
  fx.app.current = null;
  fx.pyreStakes.length = 0;
  fx.bounties.length = 0;
  fx.feeEvents.length = 0;
  fx.ledgerEntries.length = 0;
  fx.appUpdates.length = 0;
  for (const f of [fx.transferEth, fx.transferErc20, fx.transferSol, fx.pyreStakeCreate, fx.bountyCreate, fx.feeEventCreate, fx.ledgerCreate, fx.appUpdate]) f.mockClear();
});

describe("$PYRE stake (ERC-20 -> treasury)", () => {
  it("converts whole tokens to 18-decimal units, escrows to the treasury, and writes the stake row", async () => {
    fx.app.current = liveApp();
    fx.state.tokenBalance = 5000n * ETH;
    fx.state.ethBalance = GAS_RESERVE_WEI;
    const { r, c } = res();
    await pyreStakeHandler(req({ body: { appId: "app1", amount: 1000 } }), r);

    const units = 1000n * ETH;
    expect(fx.transferErc20).toHaveBeenCalledTimes(1);
    expect(fx.transferErc20.mock.calls[0]?.slice(1)).toEqual([PYRE_TOKEN, TREASURY, units]);
    expect(fx.pyreStakes).toHaveLength(1);
    expect(fx.pyreStakes[0]).toMatchObject({ appId: "app1", wallet: USER.wallet, amount: dec(units), depositTx: "0x" + "e2".repeat(32) });
    expect(c.status).toBe(201);
  });

  it("rejects with insufficient_balance and writes nothing when the token balance is short", async () => {
    fx.app.current = liveApp();
    fx.state.tokenBalance = 1000n * ETH - 1n;
    fx.state.ethBalance = GAS_RESERVE_WEI;
    const { r } = res();
    await expect(pyreStakeHandler(req({ body: { appId: "app1", amount: 1000 } }), r)).rejects.toMatchObject({ status: 400, message: "insufficient_balance" });
    expect(fx.transferErc20).not.toHaveBeenCalled();
    expect(fx.pyreStakes).toHaveLength(0);
  });

  it("rejects when the wallet cannot pay gas for the ERC-20 transfer", async () => {
    fx.app.current = liveApp();
    fx.state.tokenBalance = 5000n * ETH;
    fx.state.ethBalance = GAS_RESERVE_WEI - 1n;
    const { r } = res();
    await expect(pyreStakeHandler(req({ body: { appId: "app1", amount: 1000 } }), r)).rejects.toMatchObject({ status: 400, message: "insufficient_gas" });
    expect(fx.transferErc20).not.toHaveBeenCalled();
  });

  it("refuses to stake when $PYRE has no token yet (pyre_not_launched)", async () => {
    fx.state.pyreToken = undefined;
    fx.app.current = liveApp();
    fx.state.tokenBalance = 5000n * ETH;
    const { r } = res();
    await expect(pyreStakeHandler(req({ body: { appId: "app1", amount: 1000 } }), r)).rejects.toMatchObject({ status: 503, message: "pyre_not_launched" });
    expect(fx.transferErc20).not.toHaveBeenCalled();
  });

  it("refuses to stake into an app that is not live or dormant", async () => {
    fx.app.current = { ...liveApp(), status: "KILLED" };
    fx.state.tokenBalance = 5000n * ETH;
    const { r } = res();
    await expect(pyreStakeHandler(req({ body: { appId: "app1", amount: 1000 } }), r)).rejects.toMatchObject({ status: 409, message: "app_not_live" });
    expect(fx.transferErc20).not.toHaveBeenCalled();
    expect(fx.pyreStakes).toHaveLength(0);
  });
});

describe("app top-up (native -> app wallet)", () => {
  it("transfers to the app wallet, credits the build budget at the ETH price, and revives a dormant app", async () => {
    fx.app.current = { ...liveApp(), status: "DORMANT" };
    fx.state.ethBalance = ETH / 2n; // 0.5 ETH
    const { r, c } = res();
    await topupHandler(req({ params: { slug: "cool" }, body: { amount: 0.1 } }), r);

    expect(fx.transferEth).toHaveBeenCalledTimes(1);
    expect(fx.transferEth.mock.calls[0]?.slice(1)).toEqual([APP_WALLET, ETH / 10n]);
    // 0.1 ETH at $2000 -> $200 -> 200_000_000 micros, 100% to build budget
    expect(fx.feeEvents).toHaveLength(1);
    expect(fx.feeEvents[0]).toMatchObject({ source: "REVIVE_BUY", wei: dec(ETH / 10n), ethPriceUsd: 2000, buildMicros: 200_000_000n, pyreMicros: 0n, launcherMicros: 0n });
    expect(fx.ledgerEntries).toHaveLength(1);
    expect(fx.ledgerEntries[0]).toMatchObject({ account: "BUILD:app1", deltaMicros: 200_000_000n });
    // dormant -> live, budget and feesWei incremented
    expect(fx.appUpdates[0]).toMatchObject({ status: "LIVE", budgetMicros: 200_000_000n, feesWei: dec(ETH / 10n) });
    expect(c.body).toMatchObject({ status: "LIVE", budgetMicros: "200000000", wei: (ETH / 10n).toString() });
  });

  it("tops up a pump.fun app in SOL from the Solana wallet, pricing the budget credit in SOL", async () => {
    fx.app.current = solApp();
    fx.state.solBalance = 2_000_000_000n; // 2 SOL
    const { r, c } = res();
    await topupHandler(req({ params: { slug: "solcool" }, body: { amount: 0.5 } }), r);

    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(fx.transferSol).toHaveBeenCalledTimes(1);
    expect(fx.transferSol.mock.calls[0]?.slice(1)).toEqual([SOL_APP_WALLET, 500_000_000n]);
    // 0.5 SOL at $120 -> $60 -> 60_000_000 micros; `wei` is lamports and `ethPriceUsd` the SOL price.
    expect(fx.feeEvents[0]).toMatchObject({ source: "REVIVE_BUY", wei: dec(500_000_000n), ethPriceUsd: 120, buildMicros: 60_000_000n });
    expect(fx.ledgerEntries[0]).toMatchObject({ account: "BUILD:app2", deltaMicros: 60_000_000n });
    expect(c.body).toMatchObject({ budgetMicros: "60000000", wei: "500000000" });
  });

  it("rejects with insufficient_balance (gas headroom) and writes nothing", async () => {
    fx.app.current = liveApp();
    fx.state.ethBalance = ETH / 10n; // exactly the amount, no gas headroom
    const { r } = res();
    await expect(topupHandler(req({ params: { slug: "cool" }, body: { amount: 0.1 } }), r)).rejects.toMatchObject({ status: 400, message: "insufficient_balance" });
    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(fx.feeEvents).toHaveLength(0);
    expect(fx.appUpdates).toHaveLength(0);
  });

  it("404s when the app slug does not exist", async () => {
    fx.app.current = null;
    fx.state.ethBalance = ETH;
    const { r } = res();
    await expect(topupHandler(req({ params: { slug: "ghost" }, body: { amount: 0.1 } }), r)).rejects.toMatchObject({ status: 404, message: "app_not_found" });
    expect(fx.transferEth).not.toHaveBeenCalled();
  });

  it("409s when the app is neither live nor dormant", async () => {
    fx.app.current = { ...liveApp(), status: "KILLED" };
    fx.state.ethBalance = ETH;
    const { r } = res();
    await expect(topupHandler(req({ params: { slug: "cool" }, body: { amount: 0.1 } }), r)).rejects.toMatchObject({ status: 409, message: "app_not_live" });
    expect(fx.transferEth).not.toHaveBeenCalled();
  });
});

describe("bounty create (ETH escrow -> treasury)", () => {
  const body = { title: "Fix the thing", description: "Please fix the broken thing now", eth: 0.05 };

  it("escrows to the treasury and records the bounty plus a TREASURY ledger entry", async () => {
    fx.app.current = liveApp();
    fx.state.ethBalance = ETH; // 1 ETH
    const { r, c } = res();
    await createBountyHandler(req({ params: { slug: "cool" }, body }), r);

    const wei = ETH / 20n;
    expect(fx.transferEth).toHaveBeenCalledTimes(1);
    expect(fx.transferEth.mock.calls[0]?.slice(1)).toEqual([TREASURY, wei]);
    expect(fx.bounties).toHaveLength(1);
    expect(fx.bounties[0]).toMatchObject({ appId: "app1", authorId: USER.id, wei: dec(wei), escrowTx: "0x" + "e1".repeat(32) });
    // 0.05 ETH at $2000 -> $100 -> 100_000_000 micros credited to the treasury
    expect(fx.ledgerEntries).toHaveLength(1);
    expect(fx.ledgerEntries[0]).toMatchObject({ account: "TREASURY", deltaMicros: 100_000_000n, refType: "Bounty" });
    expect(c.status).toBe(201);
  });

  it("rejects with insufficient_balance and writes nothing", async () => {
    fx.app.current = liveApp();
    fx.state.ethBalance = ETH / 20n; // exactly the escrow, no gas headroom
    const { r } = res();
    await expect(createBountyHandler(req({ params: { slug: "cool" }, body }), r)).rejects.toMatchObject({ status: 400, message: "insufficient_balance" });
    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(fx.bounties).toHaveLength(0);
  });

  it("rejects a bounty below the minimum escrow (bounty_too_small)", async () => {
    fx.app.current = liveApp();
    fx.state.ethBalance = ETH;
    const { r } = res();
    await expect(createBountyHandler(req({ params: { slug: "cool" }, body: { ...body, eth: 0.0005 } }), r)).rejects.toMatchObject({ status: 400, message: "bounty_too_small" });
    expect(fx.transferEth).not.toHaveBeenCalled();
    expect(fx.bounties).toHaveLength(0);
  });
});
