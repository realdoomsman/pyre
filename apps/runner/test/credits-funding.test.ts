import type * as Db from "@pyre/db";
import type * as Relay from "../src/lib/relay.js";
import type * as Zentro from "../src/lib/zentro.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

/**
 * Credit funding moves treasury SOL to the card that pays Anthropic. The step machine on
 * `CreditFunding` is what keeps a crash from sending twice and a stale session from burning a
 * headless browser every pass; the quote gate is what keeps a bad Relay price from being paid; the
 * floor is what keeps a top-up from draining the SOL that claims, launches and refunds need.
 */

const TREASURY = "CZeNrWsfVqBciYLWYoLGc2wcMqozsAeVB14HVMwWqjah";
const KEYPAIR = { publicKey: TREASURY };
const DEPOSIT = getAddress("0x9b9f000000000000000000000000000000000edf");
const REQUEST = ("0x" + "17".repeat(32)) as `0x${string}`;
const SEND_SIG = "5e".repeat(44);
const FILL_TX = ("0x" + "f1".repeat(32)) as `0x${string}`;
const LUT = "Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP";
const IX = { programId: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2", keys: [{ pubkey: TREASURY, isSigner: true, isWritable: true }], data: "0d9e0ddf5fd51c06d654750700000000" };
const QUOTE_LAMPORTS = 125_129_942n;
const FLOOR = 100_000_000n; // 0.1 SOL, TREASURY_SOL_FLOOR_LAMPORTS
const usd = (n: number) => BigInt(n) * 1_000_000n;

/* ------------------------------------ in-memory prisma ------------------------------------ */

interface Row {
  id: string;
  appId: string;
  usdMicros: bigint;
  originChain: string;
  nativeWei: { toString(): string };
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
      originChain: data.originChain ?? "solana",
      nativeWei: { toString: () => "0" },
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

const getSolBalance = vi.fn();
const getSolPriceUsd = vi.fn();
/** Runs just before the broadcast (what the row looks like when the deposit goes out). */
const beforeBroadcast = vi.fn();
/** Confirmation after the broadcast: resolves, or throws like `sendInstructions` does. */
const confirm = vi.fn();
class SolanaTransactionFailedError extends Error {
  constructor(readonly signature: string | null) {
    super(`solana transaction ${signature ?? "(preflight)"} failed`);
  }
}
const sendSerializedInstructions = vi.fn(async (_payer: unknown, _ixs: unknown, opts: { onBroadcast: (signature: string) => Promise<void> }) => {
  await beforeBroadcast();
  await opts.onBroadcast(SEND_SIG);
  return confirm(SEND_SIG);
});
const quoteSolToUsdc = vi.fn();
const getRelayIntent = vi.fn();
const waitForRelayFill = vi.fn();
const getZentroDepositAddress = vi.fn();
const audit = vi.fn();
const solana = { enabled: true, cluster: "mainnet-beta" };

vi.mock("@pyre/db", async (importOriginal) => ({ ...(await importOriginal<typeof Db>()), prisma }));
const chain = {
  COMPUTE_UNITS: { relayDeposit: 40_000 },
  getSolBalance,
  getSolPriceUsd,
  sendSerializedInstructions,
  solanaEnabled: () => solana.enabled,
  solanaCluster: () => solana.cluster,
  solTreasury: () => ({ address: TREASURY, keypair: KEYPAIR }),
  SolanaTransactionFailedError,
  isSolAddress: () => true,
};
vi.mock("@pyre/chain", () => chain);
vi.mock("../src/lib/relay.js", async (importOriginal) => ({ ...(await importOriginal<typeof Relay>()), quoteSolToUsdc, getRelayIntent, waitForRelayFill }));
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
const NOW = Date.parse("2026-10-04T12:00:00Z");
const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const quoteFor = (units: bigint) => ({
  requestId: REQUEST,
  recipient: DEPOSIT,
  usdcUnits: units,
  lamports: QUOTE_LAMPORTS,
  amountOutUsd: Number(units) / 1e6,
  amountInUsd: Number(units) / 1e6 + 0.22,
  deposit: { instructions: [IX], lookupTables: [LUT] },
});
const inflight = (over: Partial<Row>): Row => ({
  id: "cf_old",
  appId: "app1",
  usdMicros: usd(20),
  originChain: "solana",
  nativeWei: { toString: () => "1" },
  usdcUnits: usd(20),
  wallet: DEPOSIT,
  status: "SENT",
  relayRequestId: REQUEST,
  sendTx: SEND_SIG,
  fillTx: null,
  error: null,
  createdAt: new Date(NOW - 60_000),
  completedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  ledger = [];
  settings = {};
  balances = {};
  seq = 0;
  env.ZENTRO_STATE = "{}";
  solana.enabled = true;
  solana.cluster = "mainnet-beta";
  getSolBalance.mockResolvedValue(10n * FLOOR * 100n);
  getSolPriceUsd.mockResolvedValue(150);
  getZentroDepositAddress.mockImplementation(async (_state: string, amountUsd: number) => ({ address: DEPOSIT, amountUsd: Math.max(15, Math.floor(amountUsd)) }));
  quoteSolToUsdc.mockImplementation(async (_from: string, _to: string, units: bigint) => quoteFor(units));
  beforeBroadcast.mockResolvedValue(undefined);
  confirm.mockImplementation(async (signature: string) => ({ signature, slot: 1 }));
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

  it("does nothing below the $15 threshold and funds ADDRESS_MINTED → SENT → CONFIRMED in SOL with a ledger debit at or above it", async () => {
    balances = { low: usd(15) - 1n, due: usd(15) };
    await fundCredits(log, NOW);

    expect(getZentroDepositAddress).toHaveBeenCalledTimes(1);
    expect(getZentroDepositAddress).toHaveBeenCalledWith("{}", 15);
    expect(quoteSolToUsdc).toHaveBeenCalledWith(TREASURY, DEPOSIT, usd(15));
    expect(sendSerializedInstructions).toHaveBeenCalledTimes(1);
    expect(sendSerializedInstructions).toHaveBeenCalledWith(KEYPAIR, [IX], { computeUnits: 40_000, lookupTables: [LUT], onBroadcast: expect.any(Function) });
    expect(waitForRelayFill).toHaveBeenCalledWith(REQUEST, expect.any(Number));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ appId: "due", originChain: "solana", status: "CONFIRMED", relayRequestId: REQUEST, sendTx: SEND_SIG, fillTx: FILL_TX, usdcUnits: usd(15), wallet: DEPOSIT });
    expect(rows[0]!.nativeWei.toString()).toBe(QUOTE_LAMPORTS.toString());
    expect(ledger).toEqual([{ account: "CREDITS:due", deltaMicros: -usd(15), refType: "CreditFunding", refId: "cf1", memo: "card top-up" }]);
    expect(balances.due).toBe(0n);
    expect(settings[CREDITS_FUNDING_SETTING]).toMatchObject({ mode: "zentro" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ originChain: "solana", nativeWei: QUOTE_LAMPORTS.toString() }) }));
  });

  it("caps one top-up at $250 and leaves the remainder accrued", async () => {
    balances = { whale: usd(1_000) + 123n };
    await fundCredits(log, NOW);
    expect(getZentroDepositAddress).toHaveBeenCalledWith("{}", MAX_CREDITS_FUNDING_USD);
    expect(rows[0]).toMatchObject({ status: "CONFIRMED", usdMicros: usd(250) });
    expect(balances.whale).toBe(usd(750) + 123n);
  });

  it("persists the intent before the broadcast and marks SENT with the signature before confirmation", async () => {
    balances = { app1: usd(20) };
    const seen: Array<{ status: string; relayRequestId: string | null; sendTx: string | null; nativeWei: string }> = [];
    const snapshot = () => seen.push({ status: rows[0]!.status, relayRequestId: rows[0]!.relayRequestId, sendTx: rows[0]!.sendTx, nativeWei: rows[0]!.nativeWei.toString() });
    beforeBroadcast.mockImplementation(async () => snapshot());
    confirm.mockImplementation(async (signature: string) => {
      snapshot();
      return { signature, slot: 1 };
    });
    await fundCredits(log, NOW);
    expect(seen).toEqual([
      { status: "ADDRESS_MINTED", relayRequestId: REQUEST, sendTx: null, nativeWei: QUOTE_LAMPORTS.toString() },
      { status: "SENT", relayRequestId: REQUEST, sendTx: SEND_SIG, nativeWei: QUOTE_LAMPORTS.toString() },
    ]);
  });

  it("settles from Relay, never re-signing, when the deposit was broadcast but its confirmation is unreadable", async () => {
    balances = { app1: usd(20) };
    confirm.mockRejectedValue(new Error(`solana transaction ${SEND_SIG} could not be confirmed`));
    await fundCredits(log, NOW);
    expect(sendSerializedInstructions).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ status: "CONFIRMED", sendTx: SEND_SIG, fillTx: FILL_TX });
    expect(ledger).toEqual([expect.objectContaining({ refId: "cf1", deltaMicros: -usd(20) })]);
  });

  it("resumes a SENT row at the status poll after a crash: no new address, no second send", async () => {
    balances = { app1: usd(20) };
    rows.push(inflight({}));
    await fundCredits(log, NOW);
    expect(getZentroDepositAddress).not.toHaveBeenCalled();
    expect(sendSerializedInstructions).not.toHaveBeenCalled();
    expect(waitForRelayFill).toHaveBeenCalledWith(REQUEST, expect.any(Number));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "cf_old", status: "CONFIRMED", fillTx: FILL_TX });
    expect(ledger).toEqual([expect.objectContaining({ refId: "cf_old", deltaMicros: -usd(20) })]);
  });

  it("still settles a SENT row paid in ETH before the cutover, keeping its origin and wei amount", async () => {
    balances = { app1: usd(20) };
    rows.push(inflight({ originChain: "robinhood", nativeWei: { toString: () => "5533841656701034" }, sendTx: "0x" + "5e".repeat(32) }));
    await fundCredits(log, NOW);
    expect(sendSerializedInstructions).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "CONFIRMED", originChain: "robinhood" });
    expect(rows[0]!.nativeWei.toString()).toBe("5533841656701034");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ originChain: "robinhood", nativeWei: "5533841656701034" }) }));
  });

  it("keeps a SENT row in flight (no ledger debit, no re-send) when Relay has not filled yet", async () => {
    balances = { app1: usd(20) };
    rows.push(inflight({}));
    waitForRelayFill.mockResolvedValue({ outcome: "timeout", status: "pending" });
    await fundCredits(log, NOW);
    expect(rows[0]).toMatchObject({ status: "SENT", error: expect.stringContaining("unconfirmed") });
    expect(ledger).toEqual([]);
    expect(sendSerializedInstructions).not.toHaveBeenCalled();
    expect(getZentroDepositAddress).not.toHaveBeenCalled();
  });

  it("adopts an ADDRESS_MINTED row whose intent Relay already saw instead of sending again", async () => {
    balances = { app1: usd(20) };
    rows.push(inflight({ status: "ADDRESS_MINTED", sendTx: null }));
    getRelayIntent.mockResolvedValue({ status: "pending", inTxHashes: [SEND_SIG], txHashes: [] });
    await fundCredits(log, NOW);
    expect(sendSerializedInstructions).not.toHaveBeenCalled();
    expect(quoteSolToUsdc).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "CONFIRMED", sendTx: SEND_SIG, fillTx: FILL_TX });
  });

  it("re-quotes an unsent ETH-era ADDRESS_MINTED row in SOL and records the new origin", async () => {
    balances = { app1: usd(20) };
    rows.push(inflight({ status: "ADDRESS_MINTED", originChain: "robinhood", relayRequestId: null, sendTx: null, usdcUnits: 0n }));
    await fundCredits(log, NOW);
    expect(quoteSolToUsdc).toHaveBeenCalledWith(TREASURY, DEPOSIT, usd(20));
    expect(rows[0]).toMatchObject({ status: "CONFIRMED", originChain: "solana", sendTx: SEND_SIG });
    expect(rows[0]!.nativeWei.toString()).toBe(QUOTE_LAMPORTS.toString());
  });

  it("abandons a stale unsent address and mints a fresh one for that coin", async () => {
    balances = { app1: usd(20) };
    rows.push(inflight({ status: "ADDRESS_MINTED", relayRequestId: null, sendTx: null, usdcUnits: 0n, createdAt: new Date(NOW - ADDRESS_TTL_MS - 1) }));
    await fundCredits(log, NOW);
    expect(rows[0]).toMatchObject({ id: "cf_old", status: "FAILED" });
    expect(getZentroDepositAddress).toHaveBeenCalledTimes(1);
    expect(rows[1]).toMatchObject({ appId: "app1", status: "CONFIRMED" });
  });

  it("fails the row without sending when the quote is refused", async () => {
    balances = { app1: usd(20) };
    quoteSolToUsdc.mockRejectedValue(new RelayQuoteError("quote output worth $19.00 for $20.00 requested (< 98%)"));
    await fundCredits(log, NOW);
    expect(sendSerializedInstructions).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("quote refused") });
    expect(balances.app1).toBe(usd(20));
  });

  it("does not mint an address the treasury SOL cannot pay for above the 0.1 SOL floor", async () => {
    balances = { app1: usd(20) };
    getSolBalance.mockResolvedValue(FLOOR + 1_000_000n);
    await fundCredits(log, NOW);
    expect(getZentroDepositAddress).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("never sends a quote that would take the treasury below the floor, and sends one that leaves exactly the floor", async () => {
    // $15 at $150/SOL passes the pre-mint estimate (0.105 SOL) but the quote wants 0.125 SOL.
    balances = { app1: usd(15) };
    getSolBalance.mockResolvedValue(FLOOR + QUOTE_LAMPORTS - 1n);
    await fundCredits(log, NOW);
    expect(getZentroDepositAddress).toHaveBeenCalledTimes(1);
    expect(sendSerializedInstructions).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "ADDRESS_MINTED", relayRequestId: null, error: null });
    expect(ledger).toEqual([]);

    getSolBalance.mockResolvedValue(FLOOR + QUOTE_LAMPORTS);
    await fundCredits(log, NOW + 60_000);
    expect(getZentroDepositAddress).toHaveBeenCalledTimes(1);
    expect(sendSerializedInstructions).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ status: "CONFIRMED" });
  });

  it("leaves balances accrued without minting while Solana mainnet is not configured", async () => {
    balances = { app1: usd(20) };
    solana.enabled = false;
    await fundCredits(log, NOW);
    solana.enabled = true;
    solana.cluster = "devnet";
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

  it("fails the row when the deposit fails on-chain or at preflight, and when Relay refunds", async () => {
    balances = { app1: usd(20) };
    confirm.mockRejectedValue(new SolanaTransactionFailedError(SEND_SIG));
    await fundCredits(log, NOW);
    expect(rows[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("relay deposit failed") });
    expect(waitForRelayFill).not.toHaveBeenCalled();
    expect(ledger).toEqual([]);

    rows = [];
    beforeBroadcast.mockRejectedValue(new SolanaTransactionFailedError(null));
    await fundCredits(log, NOW);
    expect(rows[0]).toMatchObject({ status: "FAILED", sendTx: null, error: expect.stringContaining("(preflight)") });

    rows = [];
    beforeBroadcast.mockResolvedValue(undefined);
    confirm.mockImplementation(async (signature: string) => ({ signature, slot: 1 }));
    waitForRelayFill.mockResolvedValue({ outcome: "refund", status: "refund" });
    await fundCredits(log, NOW);
    expect(rows[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("refunded") });
    expect(ledger).toEqual([]);
    expect(balances.app1).toBe(usd(20));
  });
});
