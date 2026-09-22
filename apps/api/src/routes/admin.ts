import { Router } from "express";
import { z } from "zod";
import { big, prisma, type Prisma } from "@pyre/db";
import { GLOBAL_DAILY_COMPUTE_CEILING_USD, type OpsDto } from "@pyre/shared";
import { adapterFor, getEthPriceUsd, publicClient, solanaEnabled } from "@pyre/chain";
import { requireAdmin } from "../lib/auth.js";
import { auditAdmin } from "../lib/audit.js";
import { adminJobDto } from "../lib/dto.js";
import { custodialEthBalance, custodialUsdgBalance } from "../lib/custodial.js";
import { TREASURY_WALLET } from "../lib/treasury.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { publishEvent, publishGlobal } from "../lib/events.js";
import { queues } from "../lib/queues.js";
import { env } from "../env.js";

export const admin = Router();
admin.use(requireAdmin);

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

const DAY_MS = 86_400_000;
/** Below this the treasury cannot fund launches (launch fee + gas) or relay USDG for long. */
const TREASURY_LOW_WEI = 20_000_000_000_000_000n; // 0.02 ETH
/** A $PYRE burn that has been SWAPPING this long never finished its burn leg. */
const BURN_STUCK_MS = 30 * 60_000;
/** Below this the Solana treasury cannot pre-fund a pump launch (≈0.01 SOL + float) or run a coin burn. */
const SOL_TREASURY_LOW_LAMPORTS = 200_000_000n; // 0.2 SOL

/** Treasury Solana wallet health for `OpsDto.solana`; null while the venue is disabled. */
const solanaTreasury = async (): Promise<OpsDto["solana"]> => {
  if (!solanaEnabled()) return null;
  const sol = adapterFor("pump_fun");
  const address = sol.treasury().address;
  const [lamports, solPriceUsd] = await Promise.all([sol.nativeBalance(address).catch(() => null), sol.nativePriceUsd().catch(() => 0)]);
  return { address, lamports: (lamports ?? 0n).toString(), cluster: env.SOLANA_CLUSTER, solPriceUsd, rpcOk: lamports !== null };
};

/**
 * `GET /v1/admin/ops` — `OpsDto` (what the /ops page renders) plus the detail lists the admin
 * console drills into (running/failed jobs, flags, reports, killed apps, audit tail, credits).
 */
admin.get(
  "/ops",
  wrap(async (_req, res) => {
    const now = Date.now();
    const today = dayKey(new Date(now));
    const since24h = new Date(now - DAY_MS);
    const [
      spend,
      running,
      failed,
      queued,
      failed24h,
      succeeded24h,
      flags,
      reports,
      killed,
      settings,
      statusCounts,
      users,
      reconcile,
      audit,
      ledger,
      money,
      moneySol,
      fees24h,
      fees24hSol,
      pyreBurnsPending,
      pyreBurnsStuck,
      coinBurnsPending,
      coinBurnsStuck,
      creditLedger,
      creditFunded,
      recentFundings,
      stuckFundings,
      failedFundings,
    ] = await Promise.all([
      prisma.dailyComputeSpend.findUnique({ where: { day: today } }),
      prisma.buildJob.findMany({ where: { status: "RUNNING" }, orderBy: { startedAt: "desc" }, include: { app: true } }),
      prisma.buildJob.findMany({ where: { status: "FAILED" }, orderBy: { finishedAt: "desc" }, take: 20, include: { app: true } }),
      prisma.buildJob.count({ where: { status: "QUEUED" } }),
      prisma.buildJob.count({ where: { status: "FAILED", finishedAt: { gte: since24h } } }),
      prisma.buildJob.count({ where: { status: "SUCCEEDED", finishedAt: { gte: since24h } } }),
      prisma.abuseFlag.findMany({ where: { resolved: false }, orderBy: { createdAt: "desc" }, take: 100, include: { app: { select: { slug: true } } } }),
      prisma.report.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.app.findMany({ where: { status: "KILLED" }, select: { id: true, slug: true, ticker: true, killedReason: true } }),
      prisma.platformSetting.findMany(),
      prisma.app.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.user.count(),
      // Latest run per reconcile kind. Small table, a handful of kinds — take a window and reduce.
      prisma.reconcileRun.findMany({ orderBy: { createdAt: "desc" }, take: 60 }),
      prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 25 }),
      prisma.ledgerEntry.groupBy({ by: ["account"], where: { OR: [{ account: { in: ["TREASURY", "PYRE_TOKEN"] } }, { account: { startsWith: "COINBURN:" } }] }, _sum: { deltaMicros: true } }),
      prisma.app.aggregate({ where: { chain: "robinhood" }, _sum: { feesWei: true } }),
      prisma.app.aggregate({ where: { chain: "solana" }, _sum: { feesWei: true } }),
      prisma.feeEvent.aggregate({ where: { createdAt: { gte: since24h }, app: { chain: "robinhood" } }, _sum: { wei: true } }),
      prisma.feeEvent.aggregate({ where: { createdAt: { gte: since24h }, app: { chain: "solana" } }, _sum: { wei: true } }),
      prisma.pyreBurn.count({ where: { status: { in: ["PENDING", "SWAPPED"] } } }),
      prisma.pyreBurn.count({ where: { status: "SWAPPING", createdAt: { lt: new Date(now - BURN_STUCK_MS) } } }),
      prisma.coinBurn.count({ where: { status: { in: ["PENDING", "SWAPPED"] } } }),
      prisma.coinBurn.count({ where: { status: "SWAPPING", createdAt: { lt: new Date(now - BURN_STUCK_MS) } } }),
      // Per-app model-credit accrual: every CREDITS:<appId> ledger balance.
      prisma.ledgerEntry.groupBy({ by: ["account"], where: { account: { startsWith: "CREDITS:" } }, _sum: { deltaMicros: true } }),
      // USDC actually delivered to the card, per app (all-time CONFIRMED top-ups).
      prisma.creditFunding.groupBy({ by: ["appId"], where: { status: "CONFIRMED" }, _sum: { usdcUnits: true } }),
      prisma.creditFunding.findMany({ orderBy: { createdAt: "desc" }, take: 20, include: { app: { select: { slug: true, ticker: true } } } }),
      // Top-ups wedged mid-pipeline for >30 min (address minted but unsent, or sent and unfilled) — need manual reconcile.
      prisma.creditFunding.findMany({
        where: { status: { in: ["ADDRESS_MINTED", "SENT"] }, createdAt: { lt: new Date(now - 30 * 60_000) } },
        include: { app: { select: { slug: true } } },
      }),
      prisma.creditFunding.findMany({ where: { status: "FAILED", createdAt: { gte: since24h } }, orderBy: { createdAt: "desc" }, take: 1 }),
    ]);
    const [treasuryEth, treasuryUsdg, block, ethPriceUsd, solana] = await Promise.all([
      custodialEthBalance(TREASURY_WALLET).catch(() => null),
      custodialUsdgBalance(TREASURY_WALLET).catch(() => null),
      publicClient()
        .getBlockNumber()
        .catch(() => null),
      getEthPriceUsd().catch(() => 0),
      solanaTreasury(),
    ]);
    const reportApps = await prisma.app.findMany({ where: { id: { in: reports.map((r) => r.appId) } }, select: { id: true, slug: true } });
    const slugById: Record<string, string> = {};
    for (const a of reportApps) slugById[a.id] = a.slug;
    const settingsMap: Record<string, unknown> = {};
    for (const s of settings) settingsMap[s.key] = s.value;
    const appCounts: Record<string, number> = {};
    for (const s of statusCounts) appCounts[s.status] = s._count._all;
    const ledgerMap: Record<string, string> = {};
    for (const l of ledger) ledgerMap[l.account] = (l._sum.deltaMicros ?? 0n).toString();

    // Model-credit accounting. Ledger accounts are keyed CREDITS:<appId>; roll each balance up per app and platform-wide.
    const creditByApp: Record<string, bigint> = {};
    for (const row of creditLedger) {
      const appId = row.account.slice("CREDITS:".length);
      creditByApp[appId] = (creditByApp[appId] ?? 0n) + (row._sum.deltaMicros ?? 0n);
    }
    const fundedByApp: Record<string, bigint> = {};
    for (const row of creditFunded) fundedByApp[row.appId] = row._sum.usdcUnits ?? 0n;
    const accruedTotalMicros = creditLedger.reduce((s, r) => s + (r._sum.deltaMicros ?? 0n), 0n);
    const fundedTotalUnits = creditFunded.reduce((s, r) => s + (r._sum.usdcUnits ?? 0n), 0n);
    const creditApps = await prisma.app.findMany({
      where: { OR: [{ status: { in: ["LIVE", "DORMANT"] } }, { id: { in: Object.keys(creditByApp) } }, { creditFundings: { some: {} } }] },
      select: { id: true, slug: true, ticker: true, name: true, spentMicros: true, budgetMicros: true },
    });

    const todayMicros = spend?.micros ?? 0n;
    const ceilingMicros = BigInt(GLOBAL_DAILY_COMPUTE_CEILING_USD) * 1_000_000n;
    const alerts: OpsDto["alerts"] = [];
    if (treasuryEth === null || block === null) alerts.push({ level: "critical", code: "rpc_down", message: "RPC unreachable: chain reads and payouts are failing", href: null });
    else if (treasuryEth < TREASURY_LOW_WEI)
      alerts.push({ level: "warn", code: "treasury_low", message: `Treasury holds ${(Number(treasuryEth) / 1e18).toFixed(4)} ETH (below 0.02 ETH)`, href: `${env.BLOCKSCOUT_URL}/address/${TREASURY_WALLET}` });
    if (pyreBurnsStuck > 0) alerts.push({ level: "critical", code: "pyre_burn_stuck", message: `${pyreBurnsStuck} $PYRE burn(s) stuck in SWAPPING — manual reconcile`, href: null });
    if (stuckFundings.length > 0)
      alerts.push({ level: "critical", code: "stuck_funding", message: `${stuckFundings.length} credit funding(s) stuck — manual reconcile: ${stuckFundings.map((f) => f.app.slug).join(", ")}`, href: null });
    if (failedFundings.length > 0) alerts.push({ level: "warn", code: "funding_failed", message: `Credit funding failed: ${failedFundings[0]!.error ?? "unknown error"}`, href: null });
    // Written by the runner's credits worker: how (or whether) accrued credits reach the card.
    const creditsFunding = settingsMap["credits_funding"] as { mode?: string; sessionExpiredAt?: string | null } | undefined;
    if (creditsFunding?.sessionExpiredAt) {
      alerts.push({ level: "critical", code: "ZENTRO_SESSION_EXPIRED", message: `Zentro session expired at ${creditsFunding.sessionExpiredAt}: re-capture ZENTRO_STATE on the runner; credit top-ups are paused`, href: null });
    } else if (creditsFunding?.mode === "accrue_only") {
      alerts.push({ level: "info", code: "credits_accrue_only", message: "ZENTRO_STATE is unset on the runner: credits accrue on the ledger only, nothing reaches the card", href: null });
    }
    if (todayMicros * 10n >= ceilingMicros * 8n)
      alerts.push({ level: "warn", code: "ceiling", message: `Platform compute at $${(Number(todayMicros) / 1e6).toFixed(2)} of $${GLOBAL_DAILY_COMPUTE_CEILING_USD} daily ceiling`, href: null });
    for (const flag of ["pause_builds", "pauseFeeSweep", "pauseBuyback"]) {
      if (settingsMap[flag] === true) alerts.push({ level: "info", code: flag, message: `${flag} is on`, href: null });
    }
    const latestReconcile: Record<string, (typeof reconcile)[number]> = {};
    for (const run of reconcile) latestReconcile[run.kind] ??= run;
    for (const run of Object.values(latestReconcile)) {
      if (!run.ok) alerts.push({ level: "warn", code: `reconcile_${run.kind.toLowerCase()}`, message: `Reconcile ${run.kind}: ${run.drifted} drifted of ${run.checked}`, href: null });
    }

    if (solana && !solana.rpcOk) alerts.push({ level: "critical", code: "solana_rpc_down", message: "Solana RPC unreachable: pump.fun reads, launches and coin burns are failing", href: null });
    else if (solana && BigInt(solana.lamports) < SOL_TREASURY_LOW_LAMPORTS)
      alerts.push({ level: "warn", code: "sol_treasury_low", message: `Solana treasury holds ${(Number(solana.lamports) / 1e9).toFixed(4)} SOL (below 0.2 SOL)`, href: null });
    if (coinBurnsStuck > 0) alerts.push({ level: "critical", code: "coin_burn_stuck", message: `${coinBurnsStuck} coin burn(s) stuck in SWAPPING — manual reconcile`, href: null });

    const ops: OpsDto = {
      generatedAt: new Date(now).toISOString(),
      treasury: { address: TREASURY_WALLET, ethWei: (treasuryEth ?? 0n).toString(), usdgUnits: (treasuryUsdg ?? 0n).toString() },
      solana,
      chain: { chainId: env.CHAIN_ID, blockNumber: block === null ? 0 : Number(block), ethPriceUsd, rpcOk: block !== null },
      apps: appCounts,
      jobs: { queued, running: running.length, failed24h, succeeded24h },
      compute: { todayMicros: todayMicros.toString(), ceilingMicros: ceilingMicros.toString() },
      money: {
        feesTotalWei: big(money._sum.feesWei).toString(),
        fees24hWei: big(fees24h._sum.wei).toString(),
        feesTotalLamports: big(moneySol._sum.feesWei).toString(),
        fees24hLamports: big(fees24hSol._sum.wei).toString(),
        pyreBurnsPending,
        pyreBurnsStuck,
        coinBurnsPending,
        coinBurnsStuck,
        creditFundingsStuck: stuckFundings.length,
        ledger: ledgerMap,
      },
      flags: { open: flags.length, reportsOpen: reports.length },
      settings: settingsMap,
      reconcile: Object.values(latestReconcile).map((r) => ({ kind: r.kind, ok: r.ok, drifted: r.drifted, checked: r.checked, createdAt: r.createdAt.toISOString() })),
      alerts,
    };
    res.json({
      ...ops,
      users,
      running: running.map(adminJobDto),
      failed: failed.map(adminJobDto),
      flagList: flags.map((f) => ({ id: f.id, appId: f.appId, appSlug: f.app.slug, source: f.source, category: f.category, reason: f.reason, createdAt: f.createdAt.toISOString() })),
      reportList: reports.map((r) => ({ id: r.id, appId: r.appId, appSlug: slugById[r.appId] ?? "", reporter: r.reporter, kind: r.kind, details: r.details, status: r.status, createdAt: r.createdAt.toISOString() })),
      killed,
      reconcileRuns: Object.values(latestReconcile).map((r) => ({ kind: r.kind, ok: r.ok, checked: r.checked, drifted: r.drifted, repaired: r.repaired, durationMs: r.durationMs, createdAt: r.createdAt.toISOString(), findings: r.findings })),
      audit: audit.map((a) => ({ id: a.id, actor: a.actor, actorId: a.actorId, action: a.action, targetType: a.targetType, targetId: a.targetId, meta: a.meta, createdAt: a.createdAt.toISOString() })),
      credits: {
        fundedTotalUnits: fundedTotalUnits.toString(),
        accruedTotalMicros: accruedTotalMicros.toString(),
        apps: creditApps
          .map((a) => ({
            slug: a.slug,
            ticker: a.ticker,
            name: a.name,
            spentMicros: a.spentMicros.toString(),
            budgetMicros: a.budgetMicros.toString(),
            creditsAccruedMicros: (creditByApp[a.id] ?? 0n).toString(),
            creditsFundedUnits: (fundedByApp[a.id] ?? 0n).toString(),
          }))
          .sort((x, y) => Number(BigInt(y.spentMicros) - BigInt(x.spentMicros))),
        recentFundings: recentFundings.map((f) => ({
          slug: f.app.slug,
          ticker: f.app.ticker,
          usdMicros: f.usdMicros.toString(),
          usdcUnits: f.usdcUnits.toString(),
          ethWei: big(f.ethWei).toString(),
          status: f.status,
          error: f.error,
          createdAt: f.createdAt.toISOString(),
        })),
      },
    });
  }),
);

const KillBody = z.object({ reason: z.string().min(3).max(500) });

/** Cancels every non-terminal job of an app: dequeues QUEUED ones, revokes tokens of RUNNING ones. */
const cancelAppJobs = async (appId: string): Promise<number> => {
  const jobs = await prisma.buildJob.findMany({ where: { appId, status: { in: ["QUEUED", "RUNNING"] } } });
  for (const job of jobs) {
    if (job.status === "QUEUED") await queues.build.remove(`build-${job.id}`);
  }
  await Promise.all([
    queues.intake.remove(`intake:${appId}`),
    queues.launch.remove(`launch:${appId}`),
    prisma.jobToken.updateMany({ where: { appId, revoked: false }, data: { revoked: true } }),
    prisma.buildJob.updateMany({
      where: { id: { in: jobs.map((j) => j.id) } },
      data: { status: "CANCELLED", finishedAt: new Date() },
    }),
  ]);
  return jobs.length;
};

admin.post(
  "/apps/:id/kill",
  wrap(async (req, res) => {
    const body = parse(KillBody, req.body);
    const app = await prisma.app.findUnique({ where: { id: req.params.id! } });
    if (!app) throw new HttpError(404, "app_not_found");
    if (app.status === "KILLED") throw new HttpError(409, "already_killed");
    const cancelled = await cancelAppJobs(app.id);
    await prisma.app.update({ where: { id: app.id }, data: { status: "KILLED", killedReason: body.reason } });
    await auditAdmin(req.user!, "KILL_APP", "App", app.id, {
      slug: app.slug,
      reason: body.reason,
      previousStatus: app.status,
      cancelledJobs: cancelled,
    });
    await publishEvent(app.id, { type: "AGENT_NOTE", text: `App killed by moderation: ${body.reason}` });
    await publishGlobal(app.id);
    res.json({ id: app.id, status: "KILLED", cancelledJobs: cancelled });
  }),
);

admin.post(
  "/apps/:id/unkill",
  wrap(async (req, res) => {
    const app = await prisma.app.findUnique({ where: { id: req.params.id! } });
    if (!app) throw new HttpError(404, "app_not_found");
    if (app.status !== "KILLED") throw new HttpError(409, "not_killed");
    const status = app.tokenAddress ? "LIVE" : "DRAFT";
    await prisma.app.update({ where: { id: app.id }, data: { status, killedReason: null } });
    await auditAdmin(req.user!, "UNKILL_APP", "App", app.id, {
      slug: app.slug,
      status,
      clearedReason: app.killedReason,
    });
    await publishEvent(app.id, { type: "AGENT_NOTE", text: "App restored by moderation" });
    await publishGlobal(app.id);
    res.json({ id: app.id, status });
  }),
);

admin.post(
  "/flags/:id/resolve",
  wrap(async (req, res) => {
    const flag = await prisma.abuseFlag.findUnique({ where: { id: req.params.id! } });
    if (!flag) throw new HttpError(404, "flag_not_found");
    await prisma.abuseFlag.update({ where: { id: flag.id }, data: { resolved: true } });
    await auditAdmin(req.user!, "RESOLVE_FLAG", "AbuseFlag", flag.id, {
      appId: flag.appId,
      source: flag.source,
      category: flag.category,
    });
    res.json({ id: flag.id, resolved: true });
  }),
);

const ReportBody = z.object({ status: z.enum(["ACTIONED", "DISMISSED"]) });

admin.post(
  "/reports/:id",
  wrap(async (req, res) => {
    const body = parse(ReportBody, req.body);
    const report = await prisma.report.findUnique({ where: { id: req.params.id! } });
    if (!report) throw new HttpError(404, "report_not_found");
    await prisma.report.update({ where: { id: report.id }, data: { status: body.status, resolvedAt: new Date() } });
    await auditAdmin(req.user!, "REPORT_ACTION", "Report", report.id, {
      appId: report.appId,
      kind: report.kind,
      previousStatus: report.status,
      status: body.status,
    });
    res.json({ id: report.id, status: body.status });
  }),
);

const JobsQuery = z.object({
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

admin.get(
  "/jobs",
  wrap(async (req, res) => {
    const q = parse(JobsQuery, req.query);
    const jobs = await prisma.buildJob.findMany({
      where: q.status ? { status: q.status } : {},
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { app: true },
    });
    res.json({ items: jobs.map(adminJobDto) });
  }),
);

admin.post(
  "/jobs/:id/cancel",
  wrap(async (req, res) => {
    const job = await prisma.buildJob.findUnique({ where: { id: req.params.id! } });
    if (!job) throw new HttpError(404, "job_not_found");
    if (job.status !== "QUEUED" && job.status !== "RUNNING") throw new HttpError(409, "job_finished", { status: job.status });
    if (job.status === "QUEUED") await queues.build.remove(`build-${job.id}`);
    await prisma.jobToken.updateMany({ where: { jobId: job.id }, data: { revoked: true } });
    await prisma.buildJob.update({ where: { id: job.id }, data: { status: "CANCELLED", finishedAt: new Date() } });
    await auditAdmin(req.user!, "CANCEL_JOB", "BuildJob", job.id, {
      appId: job.appId,
      stage: job.stage,
      previousStatus: job.status,
      costMicros: job.costMicros.toString(),
    });
    await publishEvent(job.appId, { type: "AGENT_NOTE", text: `Job ${job.id} (${job.stage}) cancelled by admin` }, job.id);
    res.json({ id: job.id, status: "CANCELLED" });
  }),
);

const JsonValue: z.ZodType<Prisma.InputJsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.array(JsonValue), z.record(JsonValue)]),
);
const SettingBody = z.object({ key: z.string().min(1).max(100), value: JsonValue });

admin.post(
  "/settings",
  wrap(async (req, res) => {
    const body = parse(SettingBody, req.body);
    const before = await prisma.platformSetting.findUnique({ where: { key: body.key } });
    await prisma.platformSetting.upsert({
      where: { key: body.key },
      create: { key: body.key, value: body.value },
      update: { value: body.value },
    });
    await auditAdmin(req.user!, "SET_SETTING", "PlatformSetting", body.key, {
      key: body.key,
      previousValue: before?.value ?? null,
      value: body.value,
    });
    res.json({ key: body.key, value: body.value });
  }),
);

const AuditQuery = z.object({
  cursor: z.string().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Privileged action log, newest first. `nextCursor` is null once the last page is reached. */
admin.get(
  "/audit",
  wrap(async (req, res) => {
    const q = parse(AuditQuery, req.query);
    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, q.limit);
    const actors = await prisma.user.findMany({
      where: { id: { in: page.flatMap((r) => (r.actorId ? [r.actorId] : [])) } },
      select: { id: true, displayName: true, wallet: true },
    });
    const actorById: Record<string, { displayName: string | null; wallet: string | null }> = {};
    for (const a of actors) actorById[a.id] = { displayName: a.displayName, wallet: a.wallet };
    res.json({
      items: page.map((r) => ({
        id: r.id,
        actor: r.actor,
        actorId: r.actorId,
        actorName: r.actorId ? (actorById[r.actorId]?.displayName ?? null) : null,
        actorWallet: r.actorId ? (actorById[r.actorId]?.wallet ?? null) : null,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        meta: r.meta,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    });
  }),
);
