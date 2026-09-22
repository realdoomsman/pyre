#!/usr/bin/env node
/*
 * Probe the Zentro headless deposit-address flow with the stored ZENTRO_STATE, without moving any
 * money. Mints one fresh USDC-on-Ethereum deposit address and prints it masked; with --quote it
 * also fetches (never sends) the Relay EXACT_OUTPUT quote the runner would use for that address.
 * Needs `npx playwright install chromium` locally; the runner image ships headless Chromium.
 *   railway ssh --service runner "node apps/runner/scripts/probe-zentro.mjs [amountUsd] [--quote]"
 *   ZENTRO_STATE=$(cat .secrets/zentro-state.json) node apps/runner/scripts/probe-zentro.mjs 15 --quote
 */
import { getZentroDepositAddress, maskAddress } from "../dist/lib/zentro.js";
import { quoteEthToUsdc } from "../dist/lib/relay.js";

const raw = process.env.ZENTRO_STATE;
if (!raw) {
  console.error("ZENTRO_STATE is not set");
  process.exit(1);
}
const args = process.argv.slice(2);
const amount = Number(args.find((a) => !a.startsWith("--")) || "15");
const wantQuote = args.includes("--quote");
try {
  const started = Date.now();
  const { address, amountUsd } = await getZentroDepositAddress(raw, amount);
  console.log(`OK: minted a $${amountUsd} USDC (Ethereum) deposit address in ${((Date.now() - started) / 1000).toFixed(1)}s → ${maskAddress(address)} (len ${address.length})`);
  if (wantQuote) {
    // Any sender works for a quote; the treasury is the real one but needs the master seed, which a probe should not load.
    const quote = await quoteEthToUsdc("0x000000000000000000000000000000000000dEaD", address, BigInt(amountUsd) * 1_000_000n);
    console.log(
      `OK: relay quote ${quote.requestId.slice(0, 10)}… → ${maskAddress(quote.recipient)}: ${quote.usdcUnits} USDC units (≈$${quote.amountOutUsd.toFixed(2)}) for ${quote.ethWei} wei (≈$${quote.amountInUsd.toFixed(2)}); tx to ${quote.tx.to} on chain ${quote.tx.chainId}, value ${quote.tx.value} wei — NOT sent`,
    );
  }
  // No process.exit(0): on Windows it races Playwright's closing pipes (libuv assertion); the loop drains on its own.
} catch (e) {
  console.error("FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
