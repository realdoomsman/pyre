#!/usr/bin/env node
/**
 * Export private keys for Pyre wallets, LOCAL USE ONLY. Reads PLATFORM_MASTER_SEED_HEX from
 * .secrets/pyre-keys.env, writes .secrets/wallets.txt (git-ignored), prints nothing sensitive.
 *
 *   node apps/runner/scripts/export-keys.mjs            # treasury + every app wallet in the DB
 *   node apps/runner/scripts/export-keys.mjs --user 3   # also a user's custodial wallet by walletIndex
 */
import fs from "node:fs";
import { HDKey } from "viem/accounts";
import { hexToBytes, toHex } from "viem";
import { deriveAppWallet, deriveWallet, treasury } from "@pyre/chain";

const env = fs.readFileSync(new URL("../../../.secrets/pyre-keys.env", import.meta.url), "utf8");
const seed = env.match(/^PLATFORM_MASTER_SEED_HEX=([0-9a-f]+)/m)?.[1];
if (!seed) throw new Error("PLATFORM_MASTER_SEED_HEX missing from .secrets/pyre-keys.env");
process.env.PLATFORM_MASTER_SEED_HEX = seed;
const hd = HDKey.fromMasterSeed(hexToBytes(`0x${seed}`));
const pk = (branch, index) => toHex(hd.derive(`m/44'/60'/${branch}'/0/${index}`).privateKey);

const lines = [
  "# Pyre wallets — generated " + new Date().toISOString(),
  "# All keys derive from PLATFORM_MASTER_SEED_HEX; back up the seed, not this file.",
  "# Import into MetaMask/Rabby on network 'Robinhood Chain' (chain id 4663, RPC https://rpc.mainnet.chain.robinhood.com).",
  "",
];
const t = treasury();
lines.push("## treasury (HD m/44'/60'/0'/0/0) — holds platform ETH; pays gas, buybacks, refunds, credit top-ups", `address=${t.address}`, `privateKey=${pk(0, 0)}`, "");

const userIdx = process.argv.indexOf("--user");
if (userIdx > 0) {
  const i = Number(process.argv[userIdx + 1]);
  const u = deriveWallet(i);
  lines.push(`## user custodial wallet walletIndex=${i} (m/44'/60'/0'/0/${i})`, `address=${u.address}`, `privateKey=${pk(0, i)}`, "");
}

try {
  const { prisma } = await import("@pyre/db");
  const apps = await prisma.app.findMany({ select: { slug: true, ticker: true, keypairIndex: true, walletAddress: true }, orderBy: { createdAt: "asc" } });
  for (const a of apps) {
    const w = deriveAppWallet(a.keypairIndex);
    lines.push(`## app $${a.ticker} (${a.slug}) — creator-fee recipient on pons; keypairIndex=${a.keypairIndex} (m/44'/60'/1'/0/${a.keypairIndex})`, `address=${w.address}${a.walletAddress && a.walletAddress !== w.address ? "  # WARNING: DB says " + a.walletAddress : ""}`, `privateKey=${pk(1, a.keypairIndex)}`, "");
  }
  await prisma.$disconnect();
  lines.push(`# ${apps.length} app wallet(s) exported`);
} catch (e) {
  lines.push("# app wallets not exported: DATABASE_URL not reachable (" + (e instanceof Error ? e.message.split("\n")[0] : String(e)) + ")");
}

fs.writeFileSync(new URL("../../../.secrets/wallets.txt", import.meta.url), lines.join("\n") + "\n", { mode: 0o600 });
console.log("wrote .secrets/wallets.txt (" + lines.filter((l) => l.startsWith("## ")).length + " wallets). Do not commit, paste, or screenshot it.");
