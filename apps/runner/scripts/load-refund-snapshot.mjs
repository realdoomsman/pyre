#!/usr/bin/env node
/**
 * Loads the PYRE refund snapshot (holders of the Robinhood Chain PYRE at REFUND_SNAPSHOT.block)
 * into RefundHolder. Safe to re-run: missing rows are created with the snapshot fields only
 * (currentBalanceUnits = minBalanceUnits = balanceUnits); existing rows are verified against the
 * file and never overwritten (holding/settled/credit/paid/link state belongs to the program). Any
 * mismatch aborts before writing anything. Each owedWei must equal
 * max(0, min(ethIn − ethOut, ethIn × min(balance, bought) / bought)) (0 when bought = 0). With --dry-run
 * and no DATABASE_URL it only validates the file.
 *
 * The file must hash to SNAPSHOT_SHA256 (the reviewed data/pyre-refund-snapshot.json); any other file
 * is refused unless --allow-unpinned is passed. New rows are refused once the refunds worker has
 * moved `refund:holdCursor` past the snapshot block (they would start at the snapshot balance and
 * miss every transfer already applied); see the runbook for the recovery.
 *
 *   railway ssh --service runner -- node apps/runner/scripts/load-refund-snapshot.mjs [--file data/pyre-refund-snapshot.json] [--dry-run] [--allow-unpinned]
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { prisma } from "@pyre/db";
import { REFUND_SNAPSHOT } from "@pyre/shared";

const fileFlag = process.argv.indexOf("--file");
const file = fileFlag === -1 ? fileURLToPath(new URL("../../../data/pyre-refund-snapshot.json", import.meta.url)) : process.argv[fileFlag + 1];
const dryRun = process.argv.includes("--dry-run");
const allowUnpinned = process.argv.includes("--allow-unpinned");
/** sha256 of the reviewed data/pyre-refund-snapshot.json (785 holders, 229 owed, 11.846939549841023398 ETH). */
const SNAPSHOT_SHA256 = "f3bd7a83de0227b23a1ec5e3ec59b15721d048d943c32b9fcb3196aae9867403";
/** Same key as REFUND_HOLD_CURSOR_KEY in apps/runner/src/workers/chain/refunds.ts. */
const HOLD_CURSOR_KEY = "refund:holdCursor";

const fail = async (message) => {
  console.error(message);
  await prisma.$disconnect();
  process.exit(2);
};

const bytes = await readFile(file).catch((err) => fail(`cannot read ${file}: ${err.message}`));
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== SNAPSHOT_SHA256) {
  if (!allowUnpinned) await fail(`${file} has sha256 ${sha256}, not the pinned ${SNAPSHOT_SHA256}; refusing (pass --allow-unpinned to load it anyway).`);
  console.warn(`WARNING: loading an unpinned file (sha256 ${sha256}) because --allow-unpinned was passed.`);
}
const snap = JSON.parse(bytes.toString("utf8"));
const header = { chainId: snap.chainId, token: snap.token, block: snap.block, blockHash: snap.blockHash };
if (
  snap.chainId !== REFUND_SNAPSHOT.chainId ||
  typeof snap.token !== "string" ||
  snap.token.toLowerCase() !== REFUND_SNAPSHOT.token.toLowerCase() ||
  snap.block !== REFUND_SNAPSHOT.block ||
  typeof snap.blockHash !== "string" ||
  snap.blockHash.toLowerCase() !== REFUND_SNAPSHOT.blockHash.toLowerCase()
) {
  await fail(`snapshot ${JSON.stringify(header)} does not match REFUND_SNAPSHOT ${JSON.stringify(REFUND_SNAPSHOT)}; refusing.`);
}
if (!Array.isArray(snap.holders) || snap.holders.length === 0) await fail("snapshot has no holders; refusing.");

const FIELDS = ["balanceUnits", "boughtUnits", "ethInWei", "ethOutWei", "owedWei"];
const uint = (v, where) => {
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error(`${where}: expected a decimal string, got ${JSON.stringify(v)}`);
  return BigInt(v);
};
/** owedWei = max(0, min(in − out, in × min(balance, bought) / bought)), 0 when nothing was bought; integer floor. */
const owedFor = (balance, bought, ethIn, ethOut) => {
  if (bought === 0n) return 0n;
  const loss = ethIn - ethOut;
  const cap = (ethIn * (balance < bought ? balance : bought)) / bought;
  const owed = loss < cap ? loss : cap;
  return owed > 0n ? owed : 0n;
};
const rows = [];
const seen = new Set();
try {
  for (const [i, h] of snap.holders.entries()) {
    const address = getAddress(h.address);
    if (address !== h.address) throw new Error(`holders[${i}]: ${h.address} is not checksummed (${address})`);
    if (seen.has(address)) throw new Error(`holders[${i}]: duplicate ${address}`);
    seen.add(address);
    const [balanceUnits, boughtUnits, ethInWei, ethOutWei, owedWei] = FIELDS.map((f) => uint(h[f], `holders[${i}].${f}`));
    if (balanceUnits === 0n) throw new Error(`holders[${i}]: ${address} held 0 PYRE at the snapshot block`);
    const expected = owedFor(balanceUnits, boughtUnits, ethInWei, ethOutWei);
    if (owedWei !== expected) {
      throw new Error(`holders[${i}]: ${address} owedWei ${owedWei} != max(0, min(in − out, in × min(balance, bought) / bought)) ${expected}`);
    }
    rows.push({ address, balanceUnits, boughtUnits, ethInWei, ethOutWei, owedWei });
  }
} catch (err) {
  await fail(err.message);
}

// --dry-run without DATABASE_URL validates the file only.
const fileOnly = dryRun && !process.env.DATABASE_URL;
const existing = fileOnly
  ? []
  : await prisma.refundHolder.findMany({ select: { address: true, balanceUnits: true, boughtUnits: true, ethInWei: true, ethOutWei: true, owedWei: true } });
const byAddress = new Map(existing.map((e) => [e.address, e]));
const mismatches = [];
const missing = [];
for (const r of rows) {
  const e = byAddress.get(r.address);
  if (!e) {
    missing.push(r);
    continue;
  }
  for (const f of FIELDS) {
    if (BigInt(e[f].toFixed()) !== r[f]) mismatches.push(`${r.address}.${f}: db ${e[f].toFixed()} vs file ${r[f]}`);
  }
}
const extra = existing.filter((e) => !seen.has(e.address)).map((e) => e.address);
if (mismatches.length > 0 || extra.length > 0) {
  await fail(`database disagrees with the snapshot; nothing written.\n${[...mismatches, ...extra.map((a) => `${a}: in db, not in file`)].join("\n")}`);
}

if (!dryRun && missing.length > 0) {
  const cursor = await prisma.platformSetting.findUnique({ where: { key: HOLD_CURSOR_KEY } });
  if (cursor && typeof cursor.value === "string" && BigInt(cursor.value) > BigInt(REFUND_SNAPSHOT.block)) {
    await fail(
      [
        `${HOLD_CURSOR_KEY} is at block ${cursor.value}, past the snapshot block ${REFUND_SNAPSHOT.block}: ${missing.length} new row(s) would start at`,
        "their snapshot balance and miss every PYRE transfer already applied. Nothing written.",
        `Recover: delete the cursor (DELETE FROM "PlatformSetting" WHERE key = '${HOLD_CURSOR_KEY}';) and rerun this loader.`,
        "That is safe: the next refunds pass replays every holder from the snapshot balance (trackHolding resets",
        "current/min balances when it starts at the snapshot block), so existing rows are recomputed, not double-applied.",
      ].join("\n"),
    );
  }
  await prisma.refundHolder.createMany({
    data: missing.map((r) => ({
      address: r.address,
      balanceUnits: r.balanceUnits.toString(),
      // Holding starts at the snapshot balance; the refunds worker tracks it from Transfer logs after the snapshot block.
      currentBalanceUnits: r.balanceUnits.toString(),
      minBalanceUnits: r.balanceUnits.toString(),
      boughtUnits: r.boughtUnits.toString(),
      ethInWei: r.ethInWei.toString(),
      ethOutWei: r.ethOutWei.toString(),
      owedWei: r.owedWei.toString(),
    })),
  });
}

const sum = (f) => rows.reduce((acc, r) => acc + r[f], 0n);
const eth = (wei) => `${wei / 10n ** 18n}.${(wei % 10n ** 18n).toString().padStart(18, "0")}`;
console.log(
  JSON.stringify(
    {
      file,
      dryRun,
      database: !fileOnly,
      holders: rows.length,
      owedHolders: rows.filter((r) => r.owedWei > 0n).length,
      created: dryRun ? 0 : missing.length,
      wouldCreate: dryRun && !fileOnly ? missing.length : undefined,
      verified: fileOnly ? undefined : rows.length - missing.length,
      totalEthInWei: sum("ethInWei").toString(),
      totalEthOutWei: sum("ethOutWei").toString(),
      totalOwedWei: sum("owedWei").toString(),
      totalOwedEth: eth(sum("owedWei")),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
