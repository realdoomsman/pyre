#!/usr/bin/env node
/**
 * End-to-end pump.fun venue check on Solana devnet, through `pumpAdapter` exactly as the api and
 * runner use it: fund → launch → buy → claim creator fee → sell half → burn the rest → attest.
 *
 *   SOLANA_DEVNET_KEY=<base58 secret key with ≥ 0.2 devnet SOL> \
 *   node packages/chain/scripts/pump-devnet.mjs https://example.com/metadata.json
 *
 * Optional env: SOLANA_RPC_URL (default api.devnet.solana.com), PLATFORM_MASTER_SEED_HEX (a random
 * seed is generated when unset so the app wallet is fresh every run). Prints every signature with
 * a Solscan devnet link and the launch state read back after each step. Costs ≈ 0.06 SOL of the
 * funder's balance (float left in the app wallet is swept back at the end).
 *
 * Build first: `npx tsc -p packages/chain/tsconfig.json` (imports ../dist).
 */
import { randomBytes } from "node:crypto";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";

const metadataUrl = process.argv[2];
const secret = process.env.SOLANA_DEVNET_KEY;
if (!metadataUrl || !secret) {
  console.error("usage: SOLANA_DEVNET_KEY=<base58 secret> node pump-devnet.mjs <metadata json url>");
  process.exit(2);
}
process.env.SOLANA_RPC_URL ??= "https://api.devnet.solana.com";
process.env.SOLANA_CLUSTER = "devnet";
process.env.PLATFORM_MASTER_SEED_HEX ??= randomBytes(32).toString("hex");

const chain = await import("../dist/index.js");
const { pumpAdapter, attestationHash, solanaConnection } = chain;
const info = pumpAdapter.info;
const sol = (lamports) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
const link = (hash) => `${hash}  ${info.explorerTxUrl(hash)}`;
const step = (label) => console.log(`\n== ${label}`);

const funder = Keypair.fromSecretKey(bs58.decode(secret));
const funderAccount = { chain: "solana", address: funder.publicKey.toBase58(), signer: funder };
const treasury = pumpAdapter.treasury();
const app = pumpAdapter.appWallet(0);
const conn = solanaConnection();

step("wallets");
console.log("funder  ", funder.publicKey.toBase58(), sol(await pumpAdapter.nativeBalance(funderAccount.address)));
console.log("treasury", treasury.address);
console.log("app     ", app.address);
const funderBalance = await pumpAdapter.nativeBalance(funderAccount.address);
if (funderBalance < 0.15 * LAMPORTS_PER_SOL) {
  console.error(`funder needs ≥ 0.15 devnet SOL (has ${sol(funderBalance)}); faucet.solana.com or \`solana airdrop 1 ${funder.publicKey.toBase58()} -u devnet\``);
  process.exit(2);
}

step("gate");
console.log(await pumpAdapter.canLaunch(app.address));

step("fund treasury 0.1 SOL (funder → treasury) and verify like a stake");
const fundTreasury = await pumpAdapter.transferNative(funderAccount, treasury.address, BigInt(0.1 * LAMPORTS_PER_SOL));
console.log("tx", link(fundTreasury.hash), "slot", fundTreasury.block);
console.log("verify", await pumpAdapter.verifyNativeTransfer(fundTreasury.hash, treasury.address, BigInt(0.1 * LAMPORTS_PER_SOL), funderAccount.address));

step("predict launch cost (app wallet is empty: simulated with the treasury as payer)");
const cost = await pumpAdapter.predictLaunchCost(app.address);
console.log("cost", sol(cost));
const float = BigInt(0.03 * LAMPORTS_PER_SOL); // 0.01 buy + ATA rents + fees
const fundApp = await pumpAdapter.transferNative(treasury, app.address, cost + float);
console.log("fund app", link(fundApp.hash), sol(cost + float));

step("launch (create_v2, no initial buy)");
const launched = await pumpAdapter.launch(app, {
  name: "Pyre devnet probe",
  symbol: "PYRP",
  imageUrl: "https://pyre.fun/logo.png",
  metadataUrl,
  description: "pyre devnet end-to-end probe",
  socials: { website: "https://pyre.fun" },
});
console.log("tx", link(launched.hash), "slot", launched.block);
console.log("mint", launched.token, info.explorerTokenUrl(launched.token));
console.log("curve", launched.curve);
const mint = launched.token;
const show = async (label) => console.log(label, await pumpAdapter.readLaunch(mint));
await show("state after launch");

step("buy 0.01 SOL (buy_exact_sol_in)");
const spend = BigInt(0.01 * LAMPORTS_PER_SOL);
const buyQuote = await pumpAdapter.quoteBuy(mint, spend);
console.log("quote", buyQuote);
const bought = await pumpAdapter.buy(app, mint, spend, (buyQuote.tokenUnits * 99n) / 100n);
console.log("tx", link(bought.hash), "tokens", bought.tokenUnits, "spent", sol(bought.spentNative));
await show("state after buy");
console.log("app token balance", await pumpAdapter.tokenBalance(mint, app.address));

step("creator fees");
console.log("accruing", await pumpAdapter.accruingFees(mint, app.address));
console.log("sweep", await pumpAdapter.sweepFees(app, mint));
const claimed = await pumpAdapter.claimFees(app, mint);
console.log("claim", claimed.hash ? link(claimed.hash) : "(nothing owed)", "amount", sol(claimed.amount));
console.log("accruing after", await pumpAdapter.accruingFees(mint, app.address));

step("sell half");
const held = await pumpAdapter.tokenBalance(mint, app.address);
const half = held / 2n;
const sellQuote = await pumpAdapter.quoteSell(mint, half);
console.log("quote", sellQuote);
const sold = await pumpAdapter.sell(app, mint, half, (sellQuote.native * 99n) / 100n);
console.log("tx", link(sold.hash), "received", sol(sold.receivedNative));

step("burn the rest + attest from the treasury");
const rest = await pumpAdapter.tokenBalance(mint, app.address);
const burned = await pumpAdapter.burn(app, mint, rest);
console.log("burn tx", link(burned.hash), "units", burned.burnedUnits);
const digest = attestationHash([`devnet:${mint}`, burned.hash]);
const attested = await pumpAdapter.attest(treasury, digest);
console.log("attest tx", link(attested.hash), "digest", digest);
console.log("read back", await pumpAdapter.readAttestation(attested.hash));
await show("state after burn");

step("index");
const now = await pumpAdapter.currentBlock();
const trades = await pumpAdapter.trades(mint, launched.block, now);
console.log("trades", trades);
try {
  console.log("holders", await pumpAdapter.holders(mint, 10));
} catch (err) {
  console.log("holders unavailable on this RPC:", err instanceof Error ? err.message : err);
}

step("sweep float back to the funder");
// Leave the rent-exempt minimum (0-byte account) plus a tx fee behind: an account cannot be drained below rent.
const feeReserve = 890_880n + 10_000n;
for (const w of [app, treasury]) {
  const bal = await pumpAdapter.nativeBalance(w.address);
  if (bal > feeReserve * 2n) {
    const back = await pumpAdapter.transferNative(w, funderAccount.address, bal - feeReserve);
    console.log(w.address, "→ funder", sol(bal - feeReserve), link(back.hash));
  }
}
console.log("\nfunder balance", sol(await pumpAdapter.nativeBalance(funderAccount.address)));
console.log("done");
