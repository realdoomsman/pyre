#!/usr/bin/env node
/*
 * LedgerEntry hygiene. A ledger row can dangle two ways once its source is deleted:
 *   1. per-entity account (BUILD:<appId>, LAUNCHER:<userId>, STAKERS:/CONTRIB:/CREDITS:<appId>)
 *      whose app/user no longer exists, or
 *   2. any row whose refType/refId points at a FeeEvent/PyreBurn/BuildJob/CreditFunding
 *      that no longer exists (this is how demo PYRE_TOKEN rows survive an app purge).
 * Neither is cascaded by the DB because these are string keys, not FK columns. This reports both
 * and, with --remove, deletes them. TREASURY and other rows with a live/unknown ref are left alone,
 * as are seed rows whose refId is a live app id (seed-demo-data.mjs writes its per-app BUILD
 * aggregates against the app itself; they net to the app's counters and go with the app).
 *
 *   node apps/api/scripts/clean-orphan-ledger.mjs            # report only
 *   node apps/api/scripts/clean-orphan-ledger.mjs --remove   # delete orphans
 */
import { prisma } from "@pyre/db";

const remove = process.argv.includes("--remove");
const APP_ACCOUNTS = { BUILD: true, STAKERS: true, CONTRIB: true, CREDITS: true };

const [rows, apps, users, fees, burns, jobs, fundings] = await Promise.all([
  prisma.ledgerEntry.findMany({ select: { id: true, account: true, deltaMicros: true, refType: true, refId: true, createdAt: true } }),
  prisma.app.findMany({ select: { id: true } }),
  prisma.user.findMany({ select: { id: true } }),
  prisma.feeEvent.findMany({ select: { id: true } }),
  prisma.pyreBurn.findMany({ select: { id: true } }),
  prisma.buildJob.findMany({ select: { id: true } }),
  prisma.creditFunding.findMany({ select: { id: true } }),
]);
const appIds = new Set(apps.map((a) => a.id));
const userIds = new Set(users.map((u) => u.id));
const REF_SETS = {
  FeeEvent: new Set(fees.map((r) => r.id)),
  PyreBurn: new Set(burns.map((r) => r.id)),
  BuildJob: new Set(jobs.map((r) => r.id)),
  CreditFunding: new Set(fundings.map((r) => r.id)),
};

const orphans = rows.filter((r) => {
  const sep = r.account.indexOf(":");
  if (sep !== -1) {
    const kind = r.account.slice(0, sep);
    const id = r.account.slice(sep + 1);
    if (id && APP_ACCOUNTS[kind] && !appIds.has(id)) return true;
    if (id && kind === "LAUNCHER" && !userIds.has(id)) return true;
  }
  if (appIds.has(r.refId)) return false;
  const refSet = REF_SETS[r.refType];
  return refSet !== undefined && !refSet.has(r.refId);
});

console.log(`${orphans.length} orphaned ledger row(s) of ${rows.length} total`);
for (const o of orphans) {
  console.log(`  ${o.account}  ${o.refType}:${o.refId}  ${o.deltaMicros.toString()}  ${o.createdAt.toISOString()}`);
}
if (remove && orphans.length > 0) {
  const res = await prisma.ledgerEntry.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
  console.log(`removed ${res.count} orphaned ledger row(s)`);
} else if (orphans.length > 0) {
  console.log("run with --remove to delete them");
}
await prisma.$disconnect();
