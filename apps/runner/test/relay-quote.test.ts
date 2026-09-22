import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { MIN_OUTPUT_RATIO, quoteEthToUsdc, RelayQuoteError, USDC_MAINNET, waitForRelayFill } from "../src/lib/relay.js";

/**
 * The Relay quote is the only price check between treasury ETH and the card. A quote that pays the
 * wrong recipient, the wrong asset, too little, or needs more than one transaction must be refused
 * before anything is signed.
 */

const SENDER = "0x00000000000000000000000000000000000000AA";
const RECIPIENT = getAddress("0x9b9f000000000000000000000000000000000edf");
const REQUEST = "0x" + "17".repeat(32);

const liveQuote = (over: { out?: Partial<{ amount: string; amountUsd: string; address: string; chainId: number }>; recipient?: string; steps?: unknown[]; value?: string; chainId?: number } = {}) => ({
  requestId: REQUEST,
  steps: over.steps ?? [
    {
      id: "deposit",
      kind: "transaction",
      items: [{ status: "incomplete", data: { from: SENDER, to: "0x4cd00e387622c35bddb9b4c962c136462338bc31", data: "0x49290c1c", value: over.value ?? "5527663914840821", chainId: over.chainId ?? 4663, gas: "32432" } }],
    },
  ],
  details: {
    operation: "swap",
    recipient: over.recipient ?? RECIPIENT,
    currencyIn: { amount: over.value ?? "5527663914840821", amountUsd: "15.115195" },
    currencyOut: {
      currency: { chainId: over.out?.chainId ?? 1, address: over.out?.address ?? USDC_MAINNET.toLowerCase() },
      amount: over.out?.amount ?? "15000000",
      amountUsd: over.out?.amountUsd ?? "14.997825",
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

describe("quoteEthToUsdc", () => {
  it("returns the single origin transaction for an acceptable EXACT_OUTPUT quote", async () => {
    respond(liveQuote());
    const q = await quoteEthToUsdc(SENDER, RECIPIENT, 15_000_000n);
    expect(q).toMatchObject({ requestId: REQUEST, recipient: RECIPIENT, usdcUnits: 15_000_000n, ethWei: 5_527_663_914_840_821n, amountOutUsd: 14.997825 });
    expect(q.tx).toEqual({ to: "0x4cD00E387622C35bDDB9b4c962C136462338BC31", data: "0x49290c1c", value: 5_527_663_914_840_821n, chainId: 4663, gas: 32_432n });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ originChainId: 4663, destinationChainId: 1, destinationCurrency: USDC_MAINNET, recipient: RECIPIENT, tradeType: "EXACT_OUTPUT", amount: "15000000" });
  });

  it("refuses an output worth less than 98% of the dollars requested", async () => {
    respond(liveQuote({ out: { amountUsd: String(15 * MIN_OUTPUT_RATIO - 0.01) } }));
    await expect(quoteEthToUsdc(SENDER, RECIPIENT, 15_000_000n)).rejects.toBeInstanceOf(RelayQuoteError);
  });

  it("refuses a quote whose recipient, asset, or destination chain differ from what was asked", async () => {
    respond(liveQuote({ recipient: SENDER }));
    await expect(quoteEthToUsdc(SENDER, RECIPIENT, 15_000_000n)).rejects.toThrow(/recipient/);
    respond(liveQuote({ out: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" } }));
    await expect(quoteEthToUsdc(SENDER, RECIPIENT, 15_000_000n)).rejects.toThrow(/not USDC on Ethereum/);
    respond(liveQuote({ out: { chainId: 8453 } }));
    await expect(quoteEthToUsdc(SENDER, RECIPIENT, 15_000_000n)).rejects.toThrow(/not USDC on Ethereum/);
  });

  it("refuses multi-step quotes and transactions on another chain", async () => {
    const q = liveQuote();
    respond({ ...q, steps: [q.steps[0], q.steps[0]] });
    await expect(quoteEthToUsdc(SENDER, RECIPIENT, 15_000_000n)).rejects.toThrow(/exactly one transaction/);
    respond(liveQuote({ chainId: 1 }));
    await expect(quoteEthToUsdc(SENDER, RECIPIENT, 15_000_000n)).rejects.toThrow(/targets chain 1/);
  });

  it("surfaces Relay's own error as a quote error", async () => {
    respond({ message: "amount too low", errorCode: "AMOUNT_TOO_LOW" }, 400);
    await expect(quoteEthToUsdc(SENDER, RECIPIENT, 1n)).rejects.toThrow(/AMOUNT_TOO_LOW/);
  });
});

describe("waitForRelayFill", () => {
  it("polls through pending to success and reports the destination hash", async () => {
    respond({ status: "pending", inTxHashes: ["0x01"] });
    respond({ status: "success", inTxHashes: ["0x01"], txHashes: ["0xf1"] });
    const fill = await waitForRelayFill(REQUEST as `0x${string}`, Date.now() + 60_000, { sleep: async () => undefined });
    expect(fill).toEqual({ outcome: "success", fillTx: "0xf1" });
  });

  it("times out without treating the intent as failed", async () => {
    respond({ status: "waiting" });
    const fill = await waitForRelayFill(REQUEST as `0x${string}`, Date.now() - 1, { sleep: async () => undefined });
    expect(fill).toEqual({ outcome: "timeout", status: "waiting" });
  });
});
