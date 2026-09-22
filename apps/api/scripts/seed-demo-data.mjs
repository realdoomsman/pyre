/**
 * Seeds demo apps with build-feed events, fees and holders so the UI can be
 * developed and verified against realistic content. Every row it writes is
 * tagged `demo:` in its prompt/memo so it can be purged in one command.
 *
 * Usage (inside the api container, cwd /repo):
 *   node apps/api/scripts/seed-demo-data.mjs
 *   node apps/api/scripts/seed-demo-data.mjs --remove
 *   node apps/api/scripts/seed-demo-data.mjs --repair   converge an existing seed, keeping app ids
 */
import { createHash, randomUUID } from "node:crypto";
import { dec, prisma } from "@pyre/db";
import { getAddress } from "viem";

const remove = process.argv.includes("--remove");
const repairOnly = process.argv.includes("--repair");
const DEMO_TAG = "demo:";
/** Coin pages live on the web app; a root-relative link would be rewritten under the app's base path. */
const WEB_ORIGIN = (process.env.WEB_ORIGIN ?? "https://pyre.fun").replace(/\/+$/, "");

const APPS = [
  {
    slug: "inboxzero",
    name: "Inbox Zero",
    ticker: "INBOX",
    oneLiner: "Turns a messy inbox into a ranked action list in one click.",
    volume24hUsd: 12_640,
    usersCount: 1842,
    priceUsd: 0.00041,
    marketCapUsd: 410_000,
    holders: 1213,
    budgetUsd: 86.4,
    spentUsd: 212.18,
    feesEth: 2.1,
    uptimeBps: 9993,
    versions: 9,
  },
  {
    slug: "shotcaller",
    name: "Shotcaller",
    ticker: "SHOT",
    oneLiner: "Pay-per-call API that grades trading screenshots for AI agents.",
    volume24hUsd: 3_860,
    usersCount: 356,
    priceUsd: 0.00017,
    marketCapUsd: 168_000,
    holders: 604,
    budgetUsd: 31.7,
    spentUsd: 128.4,
    feesEth: 0.84,
    uptimeBps: 9971,
    versions: 5,
  },
  {
    slug: "deadlinks",
    name: "Deadlinks",
    ticker: "DEAD",
    oneLiner: "Crawls a site weekly and emails a broken-link report.",
    volume24hUsd: 288,
    usersCount: 41,
    priceUsd: 0.000031,
    marketCapUsd: 31_000,
    holders: 148,
    budgetUsd: 0,
    spentUsd: 64.2,
    feesEth: 0.17,
    uptimeBps: 9820,
    versions: 3,
    dormant: true,
  },
];

const usd = (n) => BigInt(Math.round(n * 1_000_000));
/** Wei and token base-unit columns are `Decimal(78, 0)`: they take `Prisma.Decimal`, never bigint. */
const eth = (n) => dec(BigInt(Math.round(n * 1e6)) * 10n ** 12n);
const units = (tokens) => dec(BigInt(Math.round(tokens)) * 10n ** 18n);
const ETH_PRICE_USD = 2050;
const sig = () => `0x${createHash("sha256").update(randomUUID()).digest("hex")}`;
const ago = (minutes) => new Date(Date.now() - minutes * 60_000);

const FEED = (app, version) => [
  { type: "JOB_QUEUED", payload: { type: "JOB_QUEUED", stage: "ITERATE", budgetUsd: 25 }, at: 182 },
  {
    type: "JOB_STARTED",
    payload: { type: "JOB_STARTED", stage: "ITERATE", model: "claude-opus-5", sandboxId: "sbx_" + app.slug },
    at: 180,
  },
  { type: "AGENT_NOTE", payload: { type: "AGENT_NOTE", text: `Reading the spec and the top voted task for ${app.name}.` }, at: 178 },
  { type: "TOOL_CALL", payload: { type: "TOOL_CALL", tool: "Edit", summary: "src/App.tsx — add ranked action list" }, at: 171 },
  { type: "TOOL_CALL", payload: { type: "TOOL_CALL", tool: "Bash", summary: "npm run build" }, at: 164 },
  { type: "TEST_RESULT", payload: { type: "TEST_RESULT", passed: 7, failed: 0, output: "7 passed (4.1s)" }, at: 160 },
  {
    type: "LIGHTHOUSE",
    payload: { type: "LIGHTHOUSE", performance: 97, accessibility: 100, bestPractices: 92, seo: 100 },
    at: 158,
  },
  {
    type: "REVIEW",
    payload: {
      type: "REVIEW",
      verdict: "APPROVE",
      summary: "Diff matches the spec. No auth, wallet or payment surfaces touched.",
      findings: [{ severity: "INFO", text: "New function declared in the manifest." }],
    },
    at: 156,
  },
  { type: "COMMIT", payload: { type: "COMMIT", sha: sig().slice(0, 7), message: "ranked action list", url: null }, at: 155 },
  {
    type: "DEPLOY",
    payload: { type: "DEPLOY", version, url: `/a/${app.slug}/` },
    at: 154,
  },
  {
    type: "JOB_FINISHED",
    payload: { type: "JOB_FINISHED", costUsd: 18.42, durationMs: 1_612_000, summary: "Shipped the ranked action list." },
    at: 153,
  },
];

/**
 * Deterministic placeholder addresses that are VALID checksummed EVM addresses, so anything that
 * reads them on chain (the reconcile FEES check, the price worker) sees an empty account rather
 * than a parse error. Never funded: derived from a hash, no key exists.
 */
const fakeAddress = (seed) => getAddress(`0x${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`);

/**
 * Deleting an App cascades everything that points at it with a relation, but the ledger, job
 * tokens and stakes address apps by plain id — so they survive and become orphans that still
 * carry a balance. Ledger rows reference the app either directly (`refId` = app id, the seed's
 * placeholder for BUILD rows) or through a FeeEvent the cascade is about to remove (PYRE_TOKEN
 * and LAUNCHER:<user> rows), so both sets are collected before the delete. Every removal path
 * has to go through here.
 */
const purgeApps = async (where) => {
  const apps = await prisma.app.findMany({ where, select: { id: true } });
  if (apps.length === 0) return 0;
  const ids = apps.map((a) => a.id);
  const fees = await prisma.feeEvent.findMany({ where: { appId: { in: ids } }, select: { id: true } });
  const refIds = [...ids, ...fees.map((r) => r.id)];
  await prisma.ledgerEntry.deleteMany({
    where: {
      OR: [
        ...ids.flatMap((id) => [{ account: `BUILD:${id}` }, { account: `STAKERS:${id}` }, { account: `CONTRIB:${id}` }, { account: `CREDITS:${id}` }]),
        { refId: { in: refIds } },
      ],
    },
  });
  await prisma.jobToken.deleteMany({ where: { appId: { in: ids } } });
  await prisma.pyreStake.deleteMany({ where: { appId: { in: ids } } });
  await prisma.report.deleteMany({ where: { appId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { targetType: "App", targetId: { in: ids } } });
  await prisma.app.deleteMany({ where: { id: { in: ids } } });
  return apps.length;
};

/**
 * `App.liveVersion > 0` is a promise that a Deployment exists at that version: the host resolves
 * one to serve the app and falls back to the "being built" page when it cannot. A seeded app that
 * claims nine shipped versions with nothing deployed contradicts its own coin page, so seed a page.
 */
const DEPLOY_PAGE = (app) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${app.name} — seeded demo</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07090b;color:#e6edf3;font:15px/1.6 ui-monospace,Menlo,monospace}main{max-width:34rem;padding:2rem}h1{color:#22e07a;font-size:1.4rem;margin:0 0 .5rem}p{color:#9aa4ad;margin:0 0 .9rem}.note{border-left:2px solid #f5a524;padding-left:.8rem;color:#f5a524}a{color:#22e07a}</style></head>
<body><main><h1>${app.name}</h1><p>${app.oneLiner}</p><p class="note">This is a seeded demo deployment (v${app.versions}), not output the Pyre agent built. This coin's build feed, fees and holders are demo data used to develop and verify the platform.</p><p><a href="${WEB_ORIGIN}/c/${app.slug}">Coin page</a></p></main></body></html>
`;

const DEPLOY_MANIFEST = (app) => ({
  name: app.name,
  version: `${app.versions}.0.0`,
  entry: "index.html",
  functions: [],
  holderTier: null,
});

/**
 * Convergent: creates the Deployment at the claimed version, and replaces it when the stored
 * bundle no longer matches what this script would produce, so `--repair` and a fresh seed always
 * end up at the same bytes.
 */
const seedDeployment = async (appId, app) => {
  const html = Buffer.from(DEPLOY_PAGE(app));
  const manifest = Buffer.from(JSON.stringify(DEPLOY_MANIFEST(app)));
  const bundle = Buffer.concat([html, manifest]);
  const bundleSha = createHash("sha256").update(bundle).digest("hex");
  const existing = await prisma.deployment.findUnique({
    where: { appId_version: { appId, version: app.versions } },
    select: { id: true, bundleSha: true },
  });
  if (existing) {
    if (existing.bundleSha === bundleSha) return false;
    await prisma.deployment.delete({ where: { id: existing.id } });
  }
  await prisma.deployment.create({
    data: {
      appId,
      version: app.versions,
      manifest: DEPLOY_MANIFEST(app),
      bundle,
      bundleSha,
      sizeBytes: bundle.byteLength,
      createdAt: ago(154),
      files: {
        create: [
          { path: "index.html", contentType: "text/html; charset=utf-8", body: html, size: html.byteLength },
          { path: "pyre.manifest.json", contentType: "application/json; charset=utf-8", body: manifest, size: manifest.byteLength },
        ],
      },
    },
  });
  return true;
};

/**
 * `--repair`: converges an already-seeded database on what the seeder now produces, without
 * recreating the apps (which would change their ids and break every link to them). Idempotent.
 */
async function repair() {
  // Orphan ledger rows: a balance parked in an account whose app no longer exists.
  const stranded = await prisma.$queryRawUnsafe(
    `SELECT l.id, l.account, l."deltaMicros"::text AS delta FROM "LedgerEntry" l
     LEFT JOIN "App" a ON a.id = substring(l.account from position(':' in l.account) + 1)
     WHERE (l.account LIKE 'BUILD:%' OR l.account LIKE 'STAKERS:%' OR l.account LIKE 'CONTRIB:%') AND a.id IS NULL`,
  );
  if (stranded.length > 0) {
    await prisma.ledgerEntry.deleteMany({ where: { id: { in: stranded.map((r) => r.id) } } });
  }
  const strandedMicros = stranded.reduce((sum, r) => sum + BigInt(r.delta), 0n);

  // Deployments for the versions the seeded apps claim to have shipped.
  let deployed = 0;
  for (const app of APPS) {
    const row = await prisma.app.findUnique({ where: { slug: app.slug }, select: { id: true, liveVersion: true } });
    if (!row) continue;
    if (await seedDeployment(row.id, app)) deployed++;
    if (row.liveVersion !== app.versions) {
      await prisma.app.update({ where: { id: row.id }, data: { liveVersion: app.versions } });
    }
  }

  console.log(
    JSON.stringify({
      orphanLedgerRowsDeleted: stranded.length,
      strandedUsd: Number(strandedMicros) / 1e6,
      deploymentsCreated: deployed,
    }),
  );
}

async function main() {
  if (remove) {
    const count = await purgeApps({ prompt: { startsWith: DEMO_TAG } });
    // A user is addressed by the ledger through LAUNCHER:<id> only: sweep those rows with the row.
    const seedUsers = await prisma.user.findMany({ where: { googleSub: { startsWith: "seed:demo" } }, select: { id: true } });
    await prisma.ledgerEntry.deleteMany({ where: { account: { in: seedUsers.map((u) => `LAUNCHER:${u.id}`) } } });
    await prisma.user.deleteMany({ where: { id: { in: seedUsers.map((u) => u.id) } } });
    console.log(`removed ${count} demo apps`);
    return;
  }
  if (repairOnly) {
    await repair();
    return;
  }


  const launcher = await prisma.user.upsert({
    where: { googleSub: "seed:demo:launcher" },
    update: {},
    create: {
      googleSub: "seed:demo:launcher",
      displayName: "dooms",
      xHandle: "realdoomsman",
      wallet: fakeAddress("launcher"),
      reputation: 48,
    },
  });

  for (const app of APPS) {
    await purgeApps({ slug: app.slug });
    const row = await prisma.app.create({
      data: {
        slug: app.slug,
        name: app.name,
        ticker: app.ticker,
        imageUrl: "",
        prompt: `${DEMO_TAG} ${app.oneLiner}`,
        spec: {
          title: app.name,
          oneLiner: app.oneLiner,
          whatItDoes: `${app.oneLiner} Built and iterated by the Pyre build agent from trading-fee budget.`,
          mvp: ["Core flow end to end", "Holder tier gate"],
          outOfScope: ["Mobile apps", "Team accounts"],
          holderTier: { enabled: true, minHoldTokens: 250000, perks: ["Unlimited runs", "Priority queue"] },
          template: "WEB_TOOL",
          risks: ["Depends on third-party rate limits"],
        },
        specApprovedAt: ago(60 * 40),
        status: app.dormant ? "DORMANT" : "LIVE",
        launcherId: launcher.id,
        tokenAddress: fakeAddress(`token:${app.slug}`),
        walletAddress: fakeAddress(`creator:${app.slug}`),
        curveAddress: fakeAddress(`curve:${app.slug}`),
        launchedAt: ago(60 * 41),
        progress: app.marketCapUsd > 100_000 ? 1 : Math.min(0.95, app.marketCapUsd / 120_000),
        graduatedAt: app.marketCapUsd > 100_000 ? ago(60 * 30) : null,
        change24hPct: app.dormant ? -4.2 : 12.6,
        volume24hUsd: app.volume24hUsd,
        launchPhase: app.marketCapUsd > 100_000 ? 2 : 0,
        launchTx: sig(),
        budgetMicros: usd(app.budgetUsd),
        spentMicros: usd(app.spentUsd),
        feesWei: eth(app.feesEth),
        usersCount: app.usersCount,
        uptimeBps: app.uptimeBps,
        healthy: !app.dormant,
        priceUsd: app.priceUsd,
        marketCapUsd: app.marketCapUsd,
        holdersCount: app.holders,
        lastPriceAt: new Date(),
        liveVersion: app.versions,
        repoFullName: `realdoomsman/pyre-${app.slug}`,
        repoUrl: `https://github.com/realdoomsman/pyre-${app.slug}`,
        firstBuildAt: ago(60 * 38),
        mvpLiveAt: ago(60 * 36),
        milestones: ["mvp_live"],
        growthEnabled: app.usersCount >= 1000,
        createdAt: ago(60 * 42),
      },
    });

    await prisma.buildEvent.createMany({
      data: FEED(app, app.versions).map((e) => ({
        appId: row.id,
        type: e.type,
        payload: e.payload,
        createdAt: ago(e.at),
      })),
    });

    // BUILD ledger: everything ever credited to the build budget, less what the agent spent.
    // Nets to App.budgetMicros so the reconcile LEDGER check passes.
    await prisma.ledgerEntry.createMany({
      data: [
        {
          account: `BUILD:${row.id}`,
          deltaMicros: usd(app.budgetUsd + app.spentUsd),
          refType: "FeeEvent",
          refId: row.id,
          memo: "demo: creator fees credited to build budget",
          createdAt: ago(199),
        },
        {
          account: `BUILD:${row.id}`,
          deltaMicros: -usd(app.spentUsd),
          refType: "BuildJob",
          refId: row.id,
          memo: "demo: agent compute spend",
          createdAt: ago(150),
        },
      ],
    });

    const feeUsd = app.feesEth * ETH_PRICE_USD;
    const feeEvent = await prisma.feeEvent.create({
      data: {
        appId: row.id,
        source: "CREATOR_FEE",
        wei: eth(app.feesEth),
        ethPriceUsd: ETH_PRICE_USD,
        usdMicros: usd(feeUsd),
        buildMicros: usd(feeUsd * 0.6),
        pyreMicros: usd(feeUsd * 0.25),
        launcherMicros: usd(feeUsd * 0.15),
        txHash: sig(),
        createdAt: ago(200),
      },
    });

    /*
     * The platform-level accounts are read by /v1/pyre and the ops console, so a seed that
     * writes only BUILD:<app> leaves $PYRE showing $0.00. Mirror the real split: every fee
     * event credits PYRE_TOKEN and the launcher.
     */
    await prisma.ledgerEntry.createMany({
      data: [
        {
          account: "PYRE_TOKEN",
          deltaMicros: usd(feeUsd * 0.25),
          refType: "FeeEvent",
          refId: feeEvent.id,
          memo: `demo: 25% of ${app.ticker} creator fees`,
          createdAt: ago(199),
        },
        {
          account: `LAUNCHER:${launcher.id}`,
          deltaMicros: usd(feeUsd * 0.15),
          refType: "FeeEvent",
          refId: feeEvent.id,
          memo: `demo: 15% of ${app.ticker} creator fees`,
          createdAt: ago(199),
        },
      ],
    });

    if (!app.dormant) {
      await prisma.promptQueueItem.createMany({
        data: [
          { appId: row.id, authorId: launcher.id, text: "Add a weekly email digest of the top actions.", weight: units(41_200_000) },
          { appId: row.id, authorId: launcher.id, text: "Expose the ranking as a function other Pyre apps can call.", weight: units(18_900_000) },
          { appId: row.id, authorId: launcher.id, text: "Dark mode and keyboard shortcuts.", weight: units(7_400_000) },
        ],
      });
    }

    await seedDeployment(row.id, app);

    console.log(`seeded ${app.slug}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
