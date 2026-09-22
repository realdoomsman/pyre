import type * as Db from "@pyre/db";
import type * as Relay from "../src/lib/relay.js";
import type * as Zentro from "../src/lib/zentro.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

/**
 * Credit funding moves treasury ETH to the card that pays Anthropic. The step machine on
 * `CreditFunding` is what keeps a crash from sending twice and a stale session from burning a
 * headless browser every pass; the quote gate is what keeps a bad Relay price from being paid.
 */

const TREASURY = "0x00000000000000000000000000000000000000AA";
const DEPOSIT = getAddress("0x9b9f000000000000000000000000000000000edf");
const RELAY_TO = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";
const REQUEST = ("0x" + "17".repeat(32)) as `0x${string}`;
const SEND_TX = ("0x" + "5e".repeat(32)) as `0x${string}`;
const FILL_TX = ("0x" + "f1".repeat(32)) as `0x${string}`;
const FLOOR = 10_000_000_000_000_000n; // 0.01 ETH, TREASURY_FLOOR_WEI
const usd = (n: number) => BigInt(n) * 1_000_000n;

/* ------------------------------------ in-memory prisma ------------------------------------ */

interface Row {
  id: string;
  appId: string;
  usdMicros: bigint;
  ethWei: { toString(): string };
  usdcUnits: bigint;
  wallet: string;
  status: string;
  relayRequestId: string | null;
  sendTx: string | null;
  fillTx: string | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}
let rows: Row[] = [];
let ledger: Array<{ account: string; deltaMicros: bigint; refType: string; refId: string }> = [];
let settings: Record<string, unknown> = {};
let seq = 0;

const creditFunding = {
  findMany: vi.fn(async ({ where }: { where: { status: { in: string[] } } }) => rows.filter((r) => where.status.in.includes(r.status))),
  create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
    const row: Row = {
      id: `cf${++seq}`,
      appId: data.appId!,
      usdMicros: data.usdMicros!,
      ethWei: { toString: () => "0" },
      usdcUnits: 0n,
      wallet: data.wallet!,
      status: data.status ?? "ADDRESS_MINTED",
      relayRequestId: null,
      sendTx: null,
      fillTx: null,
      error: null,
      createdAt: new Date(NOW),
      completedAt: null,
    };
    rows.push(row);
    return row;
  }),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const row = rows.find((r) => r.id === where.id)!;
    Object.assign(row, data);
    return row;
  }),
};
const ledgerEntry = {
  groupBy: vi.fn(async () => Object.entries(balances).map(([appId, sum]) => ({ account: `CREDITS:${appId}`, _sum: { deltaMicros: sum } }))),
  create: vi.fn(async ({ data }: { data: (typeof ledger)[number] }) => {
    ledger.push(data);
    balances[data.account.slice("CREDITS:".length)] = (balances[data.account.slice("CREDITS:".length)] ?? 0n) + data.deltaMicros;
    return data;
  }),
};
const platformSetting = {
  findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (where.key in settings ? { key: where.key, value: settings[where.key] } : null)),
  upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => {
    settings[where.key] = create.value;
    return { key: where.key, value: create.value };
  }),
};
const prisma = { creditFunding, ledgerEntry, platformSetting, $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops) };
let balances: Record<string, bigint> = {};

/* ------------------------------------- collaborators ------------------------------------- */

const getEthBalance = vi.fn();
const getEthPriceUsd = vi.fn();
const sendTransaction = vi.fn();
const waitForSuccess = vi.fn();
class TransactionRevertedError extends Error {
  constructor(readonly hash: string) {
    super(`transaction ${hash} reverted`);
  }
}
const sendTx = vi.fn(async (_account: unknown, send: (wallet: { sendTransaction: typeof sendTransaction }) => Promise<string>) => {
  const hash = await send({ sendTransaction });
  return waitForSuccess(hash);
});
const quoteEthToUsdc = vi.fn();
const getRelayIntent = vi.fn();
const waitForRelayFill = vi.fn();
const getZentroDepositAddress = vi.fn();
const audit = vi.fn();

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma }));
const chain = {
  getEthBalance,
  getEthPriceUsd,
  publicClient: () => ({}),
  sendTx,
  TransactionRevertedError,
  treasury: () => ({ address: TREASURY, account: { address: TREASURY } }),
  ROBINHOOD_CHAIN_ID: 4663,
};
vi.mock("@pyre/chain", () => chain);
vi.mock("../src/lib/relay.js", async (importOriginal) => ({ ...(await importOriginal<typeof Relay>()), quoteEthToUsdc, getRelayIntent, waitForRelayFill }));
vi.mock("../src/lib/zentro.js", async (importOriginal) => ({ ...(await importOriginal<typeof Zentro>()), getZentroDepositAddress }));
vi.mock("../src/lib/audit.js", () => ({ audit }));
vi.mock("../src/lib/lock.js", () => ({ withLock: vi.fn() }));
vi.mock("../src/workers/chain/env.js", () => ({ chainWorkerEnv: () => env }));
vi.mock("bullmq", () => ({ Worker: class {} }));

// Referenced from the hoisted env mock, so it must be hoisted too.
const env = vi.hoisted((): { ZENTRO_STATE?: string } => ({ ZENTRO_STATE: "{}" }));
// Dynamic imports: the module binds `@pyre/db` and `@pyre/chain` at load time, so it must come after the mocks.
const { fundCredits, ADDRESS_TTL_MS, CREDITS_FUNDING_SETTING, MAX_CREDITS_FUNDING_USD, ZENTRO_SESSION_BACKOFF_MS } = await import("../src/workers/chain/credits.js");
const { RelayQuoteError } = await import("../src/lib/relay.js");
const NOW = Date.parse("2026-09-21T12:00:00Z");
const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const quoteFor = (units: bigint) => ({
  requestId: REQUEST,
  recipient: DEPOSIT,
  usdcUnits: units,
  ethWei: 5_533_841_656_701_034n,
  amountOutUsd: Number(units) / 1e6,
  amountInUsd: Number(units) / 1e6 + 0.16,
  tx: { to: RELAY_TO, data: "0x49", value: 5_533_841_656_701_034n, chainId: 4663, gas: 32_432n },
});

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  ledger = [];
  settings = {};
  balances = {};
  seq = 0;
  env.ZENTRO_STATE = "{}";
  getEthBalance.mockResolvedValue(FLOOR * 100n);
  getEthPriceUsd.mockResolvedValue(2_700);
  getZentroDepositAddress.mockImplementation(async (_state: string, amountUsd: number) => ({ address: DEPOSIT, amountUsd: Math.max(15, Math.floor(amountUsd)) }));
  quoteEthToUsdc.mockImplementation(async (_from: string, _to: string, units: bigint) => quoteFor(units));
  sendTransaction.mockResolvedValue(SEND_TX);
  waitForSuccess.mockResolvedValue({ transactionHash: SEND_TX });
  getRelayIntent.mockResolvedValue({ status: "unknown", inTxHashes: [], txHashes: [] });
  waitForRelayFill.mockResolvedValue({ outcome: "success", fillTx: FILL_TX });
});

describe("fundCredits", () => {
  it("accrues only when ZENTRO_STATE is unset and says so for /ops", async () => {
    env.ZENTRO_STATE = undefined;
    balances = { app1: usd(40) };
    await fundCredits(log, NOW);
    expect(settings[CREDITS_FUNDING_SETTING]).toMatchObject({ mode: "accrue_only", sessionExpiredAt: null });
    expect(getZentroDepositAddress).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("does nothing below the $15 threshold and funds ADDRESS_MINTED → SENT → CONFIRMED with a ledger debit at or above it", async () => {
    balances = { low: usd(15) - 1n, due: usd(15) };
    await fundCredits(log, NOW);

    expect(getZentroDepositAddress).toHaveBeenCalledTimes(1);
    expect(getZentroDepositAddress).toHaveBeenCalledWith("{}", 15);
    expect(quoteEthToUsdc).toHaveBeenCalledWith(TREASURY, DEPOSIT, usd(15));
    expect(sendTransaction).toHaveBeenCalledWith({ to: RELAY_TO, data: "0x49", value: 5_533_841_656_701_034n, gas: 32_432n });
    expect(waitForRelayFill).toHaveBeenCalledWith(REQUEST, expect.any(Number));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ appId: "due", status: "CONFIRMED", relayRequestId: REQUEST, sendTx: SEND_TX, fillTx: FILL_TX, usdcUnits: usd(15), wallet: DEPOSIT });
    expect(rows[0]!.ethWei.toString()).toBe("5533841656701034");
    expect(ledger).toEqual([{ account: "CREDITS:due", deltaMicros: -usd(15), refType: "CreditFunding", refId: "cf1", memo: "card top-up" }]);
    expect(balances.due).toBe(0n);
    expect(settings[CREDITS_FUNDING_SETTING]).toMatchObject({ mode: "zentro" });
  });

  it("caps one top-up at $250 and leaves the remainder accrued", async () => {
    balances = { whale: usd(1_000) + 123n };
    await fundCredits(log, NOW);
    expect(getZentroDepositAddress).toHaveBeenCalledWith("{}", MAX_CREDITS_FUNDING_USD);
    expect(rows[0]).toMatchObject({ status: "CONFIRMED", usdMicros: usd(250) });
    expect(balances.whale).toBe(usd(750) + 123n);
  });

  it("persists the intent before the broadcast and marks SENT in the same tick as the hash", async () => {
    balances = { app1: usd(20) };
    const seen: Array<{ status: string; relayRequestId: string | null }> = [];
    sendTransaction.mockImplementation(async () => {
      seen.push({ status: rows[0]!.status, relayRequestId: rows[0]!.relayRequestId });
      return SEND_TX;
    });
    waitForSuccess.mockImplementation(async () => {
      seen.push({ status: rows[0]!.status, relayRequestId: rows[0]!.relayRequestId });
      return { transactionHash: SEND_TX };
    });
    await fundCredits(log, NOW);
    expect(seen).toEqual([
      { status: "ADDRESS_MINTED", relayRequestId: REQUEST },
      { status: "SENT", relayRequestId: REQUEST },
    ]);
  });

  it("resumes a SENT row at the status poll after a crash: no new address, no second send", async () => {
    balances = { app1: usd(20) };
    rows.push({
      id: "cf_old",
      appId: "app1",
      usdMicros: usd(20),
      ethWei: { toString: () => "1" },
      usdcUnits: usd(20),
      wallet: DEPOSIT,
      status: "SENT",
      relayRequestId: REQUEST,
      sendTx: SEND_TX,
      fillTx: null,
      error: null,
      createdAt: new Date(NOW - 60_000),
      completedAt: null,
    });
    await fundCredits(log, NOW);
    expect(getZentroDepositAddress).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(waitForRelayFill).toHaveBeenCalledWith(REQUEST, expect.any(Number));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "cf_old", status: "CONFIRMED", fillTx: FILL_TX });
    expect(ledger).toEqual([expect.objectContaining({ refId: "cf_old", deltaMicros: -usd(20) })]);
  });

  it("keeps a SENT row in flight (no ledger debit, no re-send) when Relay has not filled yet", async () => {
    balances = { app1: usd(20) };
    rows.push({ id: "cf_old", appId: "app1", usdMicros: usd(20), ethWei: { toString: () => "1" }, usdcUnits: usd(20), wallet: DEPOSIT, status: "SENT", relayRequestId: REQUEST, sendTx: SEND_TX, fillTx: null, error: null, createdAt: new Date(NOW - 60_000), completedAt: null });
    waitForRelayFill.mockResolvedValue({ outcome: "timeout", status: "pending" });
    await fundCredits(log, NOW);
    expect(rows[0]).toMatchObject({ status: "SENT", error: expect.stringContaining("unconfirmed") });
    expect(ledger).toEqual([]);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(getZentroDepositAddress).not.toHaveBeenCalled();
  });

  it("adopts an ADDRESS_MINTED row whose intent Relay already saw instead of sending again", async () => {
    balances = { app1: usd(20) };
    rows.push({ id: "cf_old", appId: "app1", usdMicros: usd(20), ethWei: { toString: () => "1" }, usdcUnits: usd(20), wallet: DEPOSIT, status: "ADDRESS_MINTED", relayRequestId: REQUEST, sendTx: null, fillTx: null, error: null, createdAt: new Date(NOW - 60_000), completedAt: null });
    getRelayIntent.mockResolvedValue({ status: "pending", inTxHashes: [SEND_TX], txHashes: [] });
    await fundCredits(log, NOW);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(quoteEthToUsdc).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "CONFIRMED", sendTx: SEND_TX, fillTx: FILL_TX });
  });

  it("abandons a stale unsent address and mints a fresh one for that coin", async () => {
    balances = { app1: usd(20) };
    rows.push({ id: "cf_old", appId: "app1", usdMicros: usd(20), ethWei: { toString: () => "0" }, usdcUnits: 0n, wallet: DEPOSIT, status: "ADDRESS_MINTED", relayRequestId: null, sendTx: null, fillTx: null, error: null, createdAt: new Date(NOW - ADDRESS_TTL_MS - 1), completedAt: null });
    await fundCredits(log, NOW);
    expect(rows[0]).toMatchObject({ id: "cf_old", status: "FAILED" });
    expect(getZentroDepositAddress).toHaveBeenCalledTimes(1);
    expect(rows[1]).toMatchObject({ appId: "app1", status: "CONFIRMED" });
  });

  it("fails the row without sending when the quote is refused", async () => {
    balances = { app1: usd(20) };
    quoteEthToUsdc.mockRejectedValue(new RelayQuoteError("quote output worth $19.00 for $20.00 requested (< 98%)"));
    await fundCredits(log, NOW);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("quote refused") });
    expect(balances.app1).toBe(usd(20));
  });

  it("does not mint an address the treasury cannot pay for", async () => {
    balances = { app1: usd(20) };
    getEthBalance.mockResolvedValue(FLOOR + 1_000_000n);
    await fundCredits(log, NOW);
    expect(getZentroDepositAddress).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("raises ZENTRO_SESSION_EXPIRED and backs off six hours before touching Zentro again", async () => {
    balances = { app1: usd(20), app2: usd(20) };
    getZentroDepositAddress.mockRejectedValue(new Error("zentro_session_expired"));
    await fundCredits(log, NOW);
    expect(getZentroDepositAddress).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
    expect(settings[CREDITS_FUNDING_SETTING]).toMatchObject({ mode: "zentro", sessionExpiredAt: new Date(NOW).toISOString() });

    getZentroDepositAddress.mockClear();
    await fundCredits(log, NOW + ZENTRO_SESSION_BACKOFF_MS - 1);
    expect(getZentroDepositAddress).not.toHaveBeenCalled();

    getZentroDepositAddress.mockImplementation(async (_s: string, amountUsd: number) => ({ address: DEPOSIT, amountUsd }));
    await fundCredits(log, NOW + ZENTRO_SESSION_BACKOFF_MS);
    expect(getZentroDepositAddress).toHaveBeenCalled();
    expect(settings[CREDITS_FUNDING_SETTING]).toMatchObject({ mode: "zentro", sessionExpiredAt: null });
  });

  it("fails the row when the deposit reverts and when Relay refunds", async () => {
    balances = { app1: usd(20) };
    waitForSuccess.mockRejectedValue(new TransactionRevertedError(SEND_TX));
    await fundCredits(log, NOW);
    expect(rows[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("reverted") });
    expect(ledger).toEqual([]);

    rows = [];
    waitForSuccess.mockResolvedValue({ transactionHash: SEND_TX });
    waitForRelayFill.mockResolvedValue({ outcome: "refund", status: "refund" });
    await fundCredits(log, NOW);
    expect(rows[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("refunded") });
    expect(ledger).toEqual([]);
    expect(balances.app1).toBe(usd(20));
  });
});
