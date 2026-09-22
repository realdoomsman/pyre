import { afterEach, describe, expect, it } from "vitest";
import { deriveAppWallet, deriveWallet, treasury } from "./keys.js";
import { deriveSolAppWallet, deriveSolWallet, solTreasury } from "./solana/keys.js";
import { SolanaDisabledError } from "./solana/connection.js";
import { VENUE_INFO, adapterFor, venueEnabled } from "./venues.js";

const SEED = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("venue registry", () => {
  it("resolves both launchpads and rejects unknown ones", () => {
    expect(adapterFor("pons_v2").info).toBe(VENUE_INFO.pons_v2);
    expect(adapterFor("pump_fun").info).toBe(VENUE_INFO.pump_fun);
    expect(() => adapterFor("moonshot" as never)).toThrow(/unknown launchpad/);
  });

  it("describes each venue's chain, native asset and coin units", () => {
    expect(VENUE_INFO.pons_v2).toMatchObject({ chain: "robinhood", native: { symbol: "ETH", decimals: 18 }, tokenDecimals: 18, totalSupplyUnits: 10n ** 27n });
    expect(VENUE_INFO.pump_fun).toMatchObject({ chain: "solana", native: { symbol: "SOL", decimals: 9 }, tokenDecimals: 6, totalSupplyUnits: 10n ** 15n });
    expect(VENUE_INFO.pons_v2.explorerTxUrl("0xabc")).toBe("https://robinhoodchain.blockscout.com/tx/0xabc");
    expect(VENUE_INFO.pons_v2.explorerTokenUrl("0xabc")).toBe("https://robinhoodchain.blockscout.com/token/0xabc");
    expect(VENUE_INFO.pons_v2.launchpadUrl("0xabc")).toBe("https://www.ponsfamily.com/launchpad/0xabc");
    expect(VENUE_INFO.pump_fun.launchpadUrl("Mint")).toBe("https://pump.fun/coin/Mint");
  });

  it("points Solana explorer links at the configured cluster", () => {
    delete process.env.SOLANA_CLUSTER;
    expect(VENUE_INFO.pump_fun.explorerTxUrl("sig")).toBe("https://solscan.io/tx/sig");
    expect(VENUE_INFO.pump_fun.explorerAddressUrl("addr")).toBe("https://solscan.io/account/addr");
    process.env.SOLANA_CLUSTER = "devnet";
    expect(VENUE_INFO.pump_fun.explorerTxUrl("sig")).toBe("https://solscan.io/tx/sig?cluster=devnet");
    expect(VENUE_INFO.pump_fun.explorerTokenUrl("mint")).toBe("https://solscan.io/token/mint?cluster=devnet");
    process.env.SOLANA_CLUSTER = "testnet";
    expect(() => VENUE_INFO.pump_fun.explorerTxUrl("sig")).toThrow(/SOLANA_CLUSTER/);
  });

  it("derives the same keys as the module functions and validates venue-formatted strings", () => {
    const pons = adapterFor("pons_v2");
    const pump = adapterFor("pump_fun");
    expect(pons.treasury().address).toBe(treasury(SEED).address);
    expect(pons.userWallet(3).address).toBe(deriveWallet(3, SEED).address);
    expect(pons.appWallet(3).address).toBe(deriveAppWallet(3, SEED).address);
    expect(pump.treasury().address).toBe(solTreasury(SEED).address);
    expect(pump.userWallet(3).address).toBe(deriveSolWallet(3, SEED).address);
    expect(pump.appWallet(3).address).toBe(deriveSolAppWallet(3, SEED).address);
    expect(pons.isAddress(pons.treasury().address)).toBe(true);
    expect(pons.isAddress(pump.treasury().address)).toBe(false);
    expect(pump.isAddress(pump.treasury().address)).toBe(true);
    expect(pump.isAddress(pons.treasury().address)).toBe(false);
    expect(pons.isTxHash(`0x${"ab".repeat(32)}`)).toBe(true);
    expect(pons.isTxHash("38sUKnndu1SsjYHPKU3emjWkvpk3WMDMbt1WqCT7dz9RAy1GudoustsR2brKEDXfsSeuaoS2wCJokYjbWjS5Gbqh")).toBe(false);
    expect(pump.isTxHash("38sUKnndu1SsjYHPKU3emjWkvpk3WMDMbt1WqCT7dz9RAy1GudoustsR2brKEDXfsSeuaoS2wCJokYjbWjS5Gbqh")).toBe(true);
  });

  it("keeps pump's pure surface working while the venue is disabled and fails network calls loudly", async () => {
    delete process.env.SOLANA_RPC_URL;
    expect(venueEnabled("pons_v2")).toBe(true);
    expect(venueEnabled("pump_fun")).toBe(false);
    const pump = adapterFor("pump_fun");
    expect(pump.appWallet(0).chain).toBe("solana");
    await expect(pump.nativeBalance(pump.treasury().address)).rejects.toBeInstanceOf(SolanaDisabledError);
    await expect(pump.readLaunch(pump.treasury().address)).rejects.toBeInstanceOf(SolanaDisabledError);
    await expect(pump.currentBlock()).rejects.toBeInstanceOf(SolanaDisabledError);
    process.env.SOLANA_RPC_URL = "https://rpc.solana.test";
    expect(venueEnabled("pump_fun")).toBe(true);
  });
});
