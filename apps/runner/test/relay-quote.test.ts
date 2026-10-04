import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { MIN_OUTPUT_RATIO, quoteSolToUsdc, RelayQuoteError, SOL_NATIVE, SOLANA_CHAIN_ID, USDC_MAINNET, waitForRelayFill } from "../src/lib/relay.js";

/**
 * The Relay quote is the only price check between treasury SOL and the card. A quote that pays the
 * wrong recipient, the wrong asset, too little, spends other than the quoted lamports, needs a
 * signature we do not hold, or needs more than one transaction must be refused before anything is
 * signed.
 */

const SENDER = "CZeNrWsfVqBciYLWYoLGc2wcMqozsAeVB14HVMwWqjah";
const RECIPIENT = getAddress("0x9b9f000000000000000000000000000000000edf");
const REQUEST = "0x17911282555b59641c12d40cc4d36a5e483fbb9ba0f35d0b984d8daf9bdaa161";
const LAMPORTS = "125129942";
const DEPOSITORY = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
const LUT = "Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP";
/** `DepositNative`: 8-byte discriminator, amount as u64 LE (125129942), 32-byte order id — from the live quote of 2026-10-04. */
const DEPOSIT_DATA = "0d9e0ddf5fd51c06d654750700000000c8780acbf53175bcbcf2866ae0619415636812e167bcbeb7506ab5a8d37dbb45";

type Ix = { programId: string; keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>; data: string };
const depositIx = (over: Partial<Ix> = {}): Ix => ({
  programId: DEPOSITORY,
  keys: [
    { pubkey: "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc", isSigner: false, isWritable: false },
    { pubkey: SENDER, isSigner: true, isWritable: true },
    { pubkey: SENDER, isSigner: false, isWritable: false },
    { pubkey: "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ", isSigner: false, isWritable: true },
    { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false },
  ],
  data: DEPOSIT_DATA,
  ...over,
});

/** The live response shape (trimmed to the fields read), with overrides per case. */
const liveQuote = (
  over: {
    out?: Partial<{ amount: string; amountUsd: string; address: string; chainId: number }>;
    in?: Partial<{ amount: string; address: string; chainId: number }>;
    recipient?: string;
    instructions?: unknown;
    luts?: unknown;
  } = {},
) => ({
  requestId: REQUEST,
  steps: [
    {
      id: "deposit",
      kind: "transaction",
      requestId: REQUEST,
      items: [{ status: "incomplete", data: { instructions: over.instructions ?? [depositIx()], addressLookupTableAddresses: over.luts ?? [LUT] } }],
    },
  ],
  details: {
    operation: "swap",
    sender: SENDER,
    recipient: over.recipient ?? RECIPIENT,
    currencyIn: {
      currency: { chainId: over.in?.chainId ?? SOLANA_CHAIN_ID, address: over.in?.address ?? SOL_NATIVE, symbol: "SOL", decimals: 9 },
      amount: over.in?.amount ?? LAMPORTS,
      amountUsd: "15.224018",
    },
    currencyOut: {
      currency: { chainId: over.out?.chainId ?? 1, address: over.out?.address ?? USDC_MAINNET.toLowerCase(), symbol: "USDC", decimals: 6 },
      amount: over.out?.amount ?? "15000000",
      amountUsd: over.out?.amountUsd ?? "14.999475",
    },
  },
});

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const respond = (body: unknown, status = 200) => fetchMock.mockResolvedValueOnce({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const quote = () => quoteSolToUsdc(SENDER, RECIPIENT, 15_000_000n);

describe("quoteSolToUsdc", () => {
  it("returns the single Solana deposit for an acceptable EXACT_OUTPUT quote", async () => {
    respond(liveQuote());
    const q = await quote();
    expect(q).toMatchObject({ requestId: REQUEST, recipient: RECIPIENT, usdcUnits: 15_000_000n, lamports: 125_129_942n, amountOutUsd: 14.999475, amountInUsd: 15.224018 });
    expect(q.deposit).toEqual({ instructions: [depositIx()], lookupTables: [LUT] });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({
      user: SENDER,
      originChainId: SOLANA_CHAIN_ID,
      destinationChainId: 1,
      originCurrency: SOL_NATIVE,
      destinationCurrency: USDC_MAINNET,
      recipient: RECIPIENT,
      tradeType: "EXACT_OUTPUT",
      amount: "15000000",
    });
  });

  it("refuses an output worth less than 98% of the dollars requested, or fewer USDC units than asked", async () => {
    respond(liveQuote({ out: { amountUsd: String(15 * MIN_OUTPUT_RATIO - 0.01) } }));
    await expect(quote()).rejects.toBeInstanceOf(RelayQuoteError);
    respond(liveQuote({ out: { amount: "14999999" } }));
    await expect(quote()).rejects.toThrow(/delivers 14999999/);
  });

  it("refuses a quote whose recipient, asset, or destination chain differ from what was asked", async () => {
    respond(liveQuote({ recipient: "0x00000000000000000000000000000000000000AA" }));
    await expect(quote()).rejects.toThrow(/recipient/);
    respond(liveQuote({ out: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" } }));
    await expect(quote()).rejects.toThrow(/not USDC on Ethereum/);
    respond(liveQuote({ out: { chainId: 8453 } }));
    await expect(quote()).rejects.toThrow(/not USDC on Ethereum/);
  });

  it("refuses an input other than native SOL on Solana", async () => {
    respond(liveQuote({ in: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } }));
    await expect(quote()).rejects.toThrow(/not native SOL/);
    respond(liveQuote({ in: { chainId: 4663 } }));
    await expect(quote()).rejects.toThrow(/not native SOL/);
  });

  it("refuses a deposit whose instructions do not move exactly the quoted lamports", async () => {
    // Relay's summary says 0.125 SOL, but the instruction would move a different amount.
    respond(liveQuote({ in: { amount: "125129941" } }));
    await expect(quote()).rejects.toThrow(/do not move the quoted 125129941 lamports/);
    respond(liveQuote({ in: { amount: "0" } }));
    await expect(quote()).rejects.toThrow(/out of range/);
  });

  it("refuses an instruction that needs a signature from anyone but the treasury", async () => {
    const ix = depositIx();
    ix.keys[3] = { ...ix.keys[3]!, isSigner: true };
    respond(liveQuote({ instructions: [ix] }));
    await expect(quote()).rejects.toThrow(/signature from 7uTT8Xi5/);
  });

  it("refuses multi-step quotes and steps that are not a Solana instruction list", async () => {
    const q = liveQuote();
    respond({ ...q, steps: [q.steps[0], q.steps[0]] });
    await expect(quote()).rejects.toThrow(/exactly one transaction/);
    // The EVM shape (to/data/value) where instructions are expected.
    respond({ ...q, steps: [{ ...q.steps[0], items: [{ data: { to: "0x4cd00e387622c35bddb9b4c962c136462338bc31", data: "0x49290c1c", value: LAMPORTS, chainId: 4663 } }] }] });
    await expect(quote()).rejects.toThrow(/not a Solana instruction list/);
    respond(liveQuote({ instructions: [depositIx({ data: "0xzz" })] }));
    await expect(quote()).rejects.toThrow(/not a Solana instruction list/);
    respond(liveQuote({ luts: ["0x4cd00e387622c35bddb9b4c962c136462338bc31"] }));
    await expect(quote()).rejects.toThrow(/lookup tables/);
  });

  it("refuses to quote for a sender that is not a Solana address, without calling Relay", async () => {
    await expect(quoteSolToUsdc("0x00000000000000000000000000000000000000AA", RECIPIENT, 15_000_000n)).rejects.toThrow(/not a Solana address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Relay's own error as a quote error", async () => {
    respond({ message: "amount too low", errorCode: "AMOUNT_TOO_LOW" }, 400);
    await expect(quoteSolToUsdc(SENDER, RECIPIENT, 1n)).rejects.toThrow(/AMOUNT_TOO_LOW/);
  });
});

describe("waitForRelayFill", () => {
  it("polls through pending to success and reports the destination hash", async () => {
    respond({ status: "pending", inTxHashes: ["5h3Y"] });
    respond({ status: "success", inTxHashes: ["5h3Y"], txHashes: ["0xf1"] });
    const fill = await waitForRelayFill(REQUEST as `0x${string}`, Date.now() + 60_000, { sleep: async () => undefined });
    expect(fill).toEqual({ outcome: "success", fillTx: "0xf1" });
  });

  it("times out without treating the intent as failed", async () => {
    respond({ status: "waiting" });
    const fill = await waitForRelayFill(REQUEST as `0x${string}`, Date.now() - 1, { sleep: async () => undefined });
    expect(fill).toEqual({ outcome: "timeout", status: "waiting" });
  });
});
