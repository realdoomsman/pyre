import { big, dec, prisma, type CoinBurn, type Prisma } from "@pyre/db";
import { adapterFor, attestationHash, solanaEnabled, type VenueAdapter, type VenueBuyResult } from "@pyre/chain";
import { LAUNCH_PHASE, nativeFromUsdMicros } from "@pyre/shared";
import type { Logger } from "pino";
import { audit } from "../../lib/audit.js";
import { MIN_BUYBACK_MICROS } from "./buyback.js";

/** Quoted output may move between quote and fill; the fill must deliver at least this share of it. */
const SLIPPAGE_BPS = 100n;
/** The treasury wallet on a venue's chain never spends below this on a burn (a launch pre-fund must stay possible). */
const VENUE_TREASURY_FLOOR: Record<string, bigint> = { solana: 100_000_000n };

type BurnApp = Prisma.AppGetPayload<{ select: { id: true; chain: true; launchpad: true; tokenAddress: true; slug: true } }>;
const BURN_APP_SELECT = { id: true, chain: true, launchpad: true, tokenAddress: true, slug: true } as const;

/**
 * Opens the PENDING coin burn for the whole `COINBURN:<appId>` balance and debits the ledger in
 * the same transaction. Null below the buyback minimum. The attestation digest covers the credit
 * ids consumed, exactly like `PyreBurn`.
 */
export async function openCoinBurn(app: BurnApp, venue: VenueAdapter, log: Logger): Promise<CoinBurn | null> {
  const account = `COINBURN:${app.id}`;
  const balance = await prisma.ledgerEntry.aggregate({ where: { account }, _sum: { deltaMicros: true } });
  const pending = balance._sum.deltaMicros ?? 0n;
  if (pending < MIN_BUYBACK_MICROS) return null;
  const lastDebit = await prisma.ledgerEntry.findFirst({ where: { account, refType: "CoinBurn" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const consumed = await prisma.ledgerEntry.findMany({
    where: { account, deltaMicros: { gt: 0n }, ...(lastDebit ? { createdAt: { gt: lastDebit.createdAt } } : {}) },
    select: { id: true },
  });
  const nativeWei = nativeFromUsdMicros(pending, await venue.nativePriceUsd(), venue.info.native.decimals);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.coinBurn.create({ data: { appId: app.id, status: "PENDING", usdMicros: pending, nativeWei: dec(nativeWei), attestHash: attestationHash(consumed.map((e) => e.id)) } });
    await tx.ledgerEntry.create({ data: { account, deltaMicros: -pending, refType: "CoinBurn", refId: created.id, memo: "coin buyback" } });
    return created;
  });
  log.info({ coinBurnId: row.id, appId: app.id, usdMicros: pending.toString(), nativeWei: nativeWei.toString(), consumed: consumed.length }, "coin burn opened");
  return row;
}

/**
 * SWAPPED → BURNED: burn exactly what was bought from the treasury wallet on the coin's chain,
 * attest (memo tx from the treasury) and settle. Each step is persisted before the next so a
 * retry never repeats an irreversible transaction.
 */
export async function coinBurnStage(app: BurnApp, venue: VenueAdapter, burn: CoinBurn, log: Logger): Promise<void> {
  const treasury = venue.treasury();
  const token = app.tokenAddress!;
  let row = burn;
  if (!row.burnTx) {
    const amount = big(row.tokensBought);
    if (amount <= 0n) throw new Error("no coins recorded as bought; nothing to burn");
    const held = await venue.tokenBalance(token, treasury.address);
    if (held < amount) throw new Error(`treasury holds ${held} units, fewer than the ${amount} bought; refusing to burn`);
    const before = (await venue.readLaunch(token)).totalSupplyUnits;
    const burned = await venue.burn(treasury, token, amount);
    const after = (await venue.readLaunch(token)).totalSupplyUnits;
    const delta = before > after ? before - after : burned.burnedUnits;
    row = await prisma.coinBurn.update({ where: { id: row.id }, data: { burnTx: burned.hash, tokensBurned: dec(amount), burnedUnits: dec(delta), error: null } });
    log.info({ coinBurnId: row.id, burnTx: burned.hash, amount: amount.toString(), burnedUnits: delta.toString() }, "coin burned");
  }
  if (!row.attestTx) {
    const attested = await venue.attest(treasury, row.attestHash);
    row = await prisma.coinBurn.update({ where: { id: row.id }, data: { attestTx: attested.hash } });
    log.info({ coinBurnId: row.id, attestTx: attested.hash }, "coin burn attested");
  }
  row = await prisma.coinBurn.update({ where: { id: row.id }, data: { status: "BURNED", completedAt: new Date(), error: null } });
  await audit({
    actor: "worker:buyback",
    action: "COIN_BURN",
    targetType: "CoinBurn",
    targetId: row.id,
    meta: {
      appId: app.id,
      token,
      chain: app.chain,
      usdMicros: row.usdMicros,
      nativeWei: big(row.nativeWei),
      tokensBought: big(row.tokensBought),
      burnedUnits: big(row.burnedUnits),
      swapTx: row.swapTx,
      burnTx: row.burnTx,
      attestTx: row.attestTx,
      attestHash: row.attestHash,
    },
  });
}

/**
 * One app's coin buy-and-burn, mirroring the $PYRE machine: a SWAPPING row is never re-bought, a
 * SWAPPED row resumes at the burn, otherwise the PENDING row (or a freshly opened one at ≥ $5
 * pending) is bought from the treasury wallet on the coin's chain, then burned and attested.
 */
export async function runCoinBurn(app: BurnApp, log: Logger, venue: VenueAdapter = adapterFor(app.launchpad)): Promise<void> {
  const swapping = await prisma.coinBurn.findFirst({ where: { appId: app.id, status: "SWAPPING" }, orderBy: { createdAt: "asc" } });
  if (swapping) {
    log.warn({ coinBurnId: swapping.id, appId: app.id }, "coin burn stuck in SWAPPING; buy outcome unknown, needs manual reconcile, skipping");
    if (!swapping.error) await prisma.coinBurn.update({ where: { id: swapping.id }, data: { error: "interrupted mid-buy; on-chain outcome unknown, manual reconcile required" } });
    return;
  }
  const swapped = await prisma.coinBurn.findFirst({ where: { appId: app.id, status: "SWAPPED" }, orderBy: { createdAt: "asc" } });
  if (swapped) {
    try {
      await coinBurnStage(app, venue, swapped, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, coinBurnId: swapped.id }, "coin burn stage failed; will retry next cycle");
      await prisma.coinBurn.update({ where: { id: swapped.id }, data: { error: message.slice(0, 500) } });
      return;
    }
  }
  const token = app.tokenAddress!;
  const state = await venue.readLaunch(token);
  if (!state.exists || (state.phase !== LAUNCH_PHASE.CURVE && state.phase !== LAUNCH_PHASE.POOL)) {
    log.warn({ appId: app.id, phase: state.phase }, "coin has no market in this phase; burn deferred");
    return;
  }
  const row = (await prisma.coinBurn.findFirst({ where: { appId: app.id, status: "PENDING" }, orderBy: { createdAt: "asc" } })) ?? (await openCoinBurn(app, venue, log));
  if (!row) return;
  const treasury = venue.treasury();
  const nativeWei = big(row.nativeWei);
  const treasuryWei = await venue.nativeBalance(treasury.address);
  if (treasuryWei - nativeWei < (VENUE_TREASURY_FLOOR[app.chain] ?? 0n)) {
    log.warn({ coinBurnId: row.id, treasuryWei: treasuryWei.toString(), nativeWei: nativeWei.toString() }, "treasury too low for the coin buyback; left PENDING");
    return;
  }
  const quote = await venue.quoteBuy(token, nativeWei, treasury.address);
  const minOut = (quote.tokenUnits * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  // CAS PENDING → SWAPPING claims the buy; past this point the buy may have broadcast.
  const claimed = await prisma.coinBurn.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "SWAPPING" } });
  if (claimed.count !== 1) return;
  let buy: VenueBuyResult;
  try {
    buy = await venue.buy(treasury, token, nativeWei, minOut);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, coinBurnId: row.id }, "coin buy failed after claim; it may have broadcast, leaving SWAPPING for manual reconcile");
    await prisma.coinBurn.update({ where: { id: row.id }, data: { error: message.slice(0, 500) } }).catch((e) => log.error({ err: e, coinBurnId: row.id }, "failed to persist coin buy error"));
    return;
  }
  log.info({ coinBurnId: row.id, swapTx: buy.hash, tokensBought: buy.tokenUnits.toString(), spentNative: buy.spentNative.toString() }, "coin bought");
  let swappedRow: CoinBurn;
  try {
    swappedRow = await prisma.coinBurn.update({
      where: { id: row.id },
      data: { status: "SWAPPED", swapTx: buy.hash, tokensBought: dec(buy.tokenUnits), nativeWei: dec(buy.spentNative), error: null },
    });
  } catch (err) {
    log.error({ err, coinBurnId: row.id, swapTx: buy.hash }, "coin buy landed but recording SWAPPED failed; left SWAPPING for manual reconcile");
    return;
  }
  try {
    await coinBurnStage(app, venue, swappedRow, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, coinBurnId: row.id }, "coin burn stage failed; will retry next cycle");
    await prisma.coinBurn.update({ where: { id: row.id }, data: { error: message.slice(0, 500) } });
  }
}

/** Every live non-PONS app with an open row or a `COINBURN` balance worth burning. A failure never aborts the pass. */
export async function runCoinBurns(log: Logger): Promise<void> {
  if (!solanaEnabled()) return;
  const apps = await prisma.app.findMany({ where: { chain: { not: "robinhood" }, tokenAddress: { not: null }, status: { in: ["LIVE", "DORMANT"] } }, select: BURN_APP_SELECT });
  for (const app of apps) {
    try {
      await runCoinBurn(app, log.child({ appId: app.id, slug: app.slug }));
    } catch (err) {
      log.error({ err, appId: app.id }, "coin burn failed");
    }
  }
}
