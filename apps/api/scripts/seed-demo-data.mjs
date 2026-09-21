/**
 * Seeds demo apps with build-feed events, revenue and buybacks so the UI can be
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
import { attestationHash } from "@pyre/chain";
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
    revenueUsd: 4213.55,
    usersCount: 1842,
    priceUsd: 0.00041,
    marketCapUsd: 410_000,
    holders: 1213,
    budgetUsd: 86.4,
    spentUsd: 212.18,
    feesEth: 2.1,
    uptimeBps: 9993,
    buybacks: 6,
    versions: 9,
  },
  {
    slug: "shotcaller",
    name: "Shotcaller",
    ticker: "SHOT",
    oneLiner: "Pay-per-call API that grades trading screenshots for AI agents.",
    revenueUsd: 1287.02,
    usersCount: 356,
    priceUsd: 0.00017,
    marketCapUsd: 168_000,
    holders: 604,
    budgetUsd: 31.7,
    spentUsd: 128.4,
    feesEth: 0.84,
    uptimeBps: 9971,
    buybacks: 4,
    versions: 5,
  },
  {
    slug: "deadlinks",
    name: "Deadlinks",
    ticker: "DEAD",
    oneLiner: "Crawls a site weekly and emails a broken-link report.",
    revenueUsd: 96.0,
    usersCount: 41,
    priceUsd: 0.000031,
    marketCapUsd: 31_000,
    holders: 148,
    budgetUsd: 0,
    spentUsd: 64.2,
    feesEth: 0.17,
    uptimeBps: 9820,
    buybacks: 1,
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
      findings: [{ severity: "INFO", text: "New function declared in the manifest and priced at $0." }],
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
 * tokens, stakes and ad rows address apps by plain id — so they survive and become orphans that
 * still carry a balance. Every removal path has to go through here.
 */
const purgeApps = async (where) => {
  const apps = await prisma.app.findMany({ where, select: { id: true } });
  if (apps.length === 0) return 0;
  const ids = apps.map((a) => a.id);
  await prisma.ledgerEntry.deleteMany({
    where: {
      OR: [
        ...ids.flatMap((id) => [{ account: `BUILD:${id}` }, { account: `STAKERS:${id}` }, { account: `CONTRIB:${id}` }]),
        { refId: { in: ids } },
      ],
    },
  });
  await prisma.jobToken.deleteMany({ where: { appId: { in: ids } } });
  await prisma.pyreStake.deleteMany({ where: { appId: { in: ids } } });
  await prisma.adCampaign.deleteMany({ where: { advertiserAppId: { in: ids } } });
  await prisma.adImpression.deleteMany({ where: { advertiserAppId: { in: ids } } });
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
<body><main><h1>${app.name}</h1><p>${app.oneLiner}</p><p class="note">This is a seeded demo deployment (v${app.versions}), not output the Pyre agent built. This coin's build feed, revenue, holders and burns are demo data used to develop and verify the platform.</p><p><a href="${WEB_ORIGIN}/c/${app.slug}">Coin page</a></p></main></body></html>
`;

const DEPLOY_MANIFEST = (app) => ({
  name: app.name,
  version: `${app.versions}.0.0`,
  entry: "index.html",
  functions: [],
  products: [{ id: "pro", name: "Pro", priceUsd: 9, kind: "SUBSCRIPTION_MONTHLY" }],
  adSlot: false,
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

  // Attestations: every stored hash must be recomputable from the revenue actually attached.
  const buybacks = await prisma.buyback.findMany({ select: { id: true, attestHash: true, revenueEvents: { select: { id: true } } } });
  let rehashed = 0;
  for (const b of buybacks) {
    if (b.revenueEvents.length === 0) continue;
    const want = attestationHash(b.revenueEvents.map((e) => e.id));
    if (want === b.attestHash) continue;
    await prisma.buyback.update({ where: { id: b.id }, data: { attestHash: want } });
    rehashed++;
  }
  console.log(
    JSON.stringify({
      orphanLedgerRowsDeleted: stranded.length,
      strandedUsd: Number(strandedMicros) / 1e6,
      deploymentsCreated: deployed,
      attestationsRecomputed: rehashed,
      buybacksChecked: buybacks.length,
    }),
  );
}

async function main() {
  if (remove) {
    const count = await purgeApps({ prompt: { startsWith: DEMO_TAG } });
    await prisma.user.deleteMany({ where: { googleSub: { startsWith: "seed:demo" } } });
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
          whoPays: "Individual users on a one-time unlock, and agents per API call.",
          mvp: ["Core flow end to end", "Hosted checkout", "Holder tier gate"],
          outOfScope: ["Mobile apps", "Team accounts"],
          monetization: { model: "ONE_TIME", priceUsd: 9, priceDescription: "$9 one-time unlock" },
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
        volume24hUsd: app.revenueUsd * 3,
        launchPhase: app.marketCapUsd > 100_000 ? 2 : 0,
        launchTx: sig(),
        budgetMicros: usd(app.budgetUsd),
        spentMicros: usd(app.spentUsd),
        feesWei: eth(app.feesEth),
        revenueMicros: usd(app.revenueUsd),
        pendingRevenueMicros: usd(app.revenueUsd * 0.04),
        buybackWei: eth((app.revenueUsd * 0.85) / ETH_PRICE_USD),
        burnedTokens: units((app.revenueUsd * 0.85) / app.priceUsd),
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
        firstRevenueAt: ago(60 * 30),
        milestones: app.revenueUsd >= 1000 ? ["mvp_live", "revenue_1", "revenue_1000"] : ["mvp_live", "revenue_1"],
        growthEnabled: app.revenueUsd >= 1000,
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

    // Keep the seeded money self-consistent so the reconcile LEDGER check passes:
    // attested revenue + pending revenue must equal App.revenueMicros, and the
    // BUILD ledger must net to App.budgetMicros.
    const pendingUsd = app.revenueUsd * 0.04;
    const attestedTotalUsd = app.revenueUsd - pendingUsd;
    for (let i = 0; i < app.buybacks; i++) {
      const revenue = attestedTotalUsd / app.buybacks;
      const buybackUsd = revenue * 0.85;
      // The revenue event comes first: `attestHash` is the public proof of WHICH revenue funded
      // this burn, so it has to be the digest of the ids actually attached, not a placeholder.
      const event = await prisma.revenueEvent.create({
        data: {
          appId: row.id,
          source: i % 3 === 2 ? "X402" : "CHECKOUT",
          usdMicros: usd(revenue),
          payer: fakeAddress(`payer:${app.slug}`),
          reference: i % 3 === 2 ? "fn:grade" : "product:pro",
          createdAt: ago(302 - i * 40),
        },
      });
      const buyback = await prisma.buyback.create({
        data: {
          appId: row.id,
          status: "BURNED",
          revenueMicros: usd(revenue),
          ethWei: eth(buybackUsd / ETH_PRICE_USD),
          tokensBought: units(buybackUsd / app.priceUsd),
          tokensBurned: units(buybackUsd / app.priceUsd),
          burnedUnits: units(buybackUsd / app.priceUsd),
          attestTx: sig(),
          pyreMicros: usd(revenue * 0.1),
          opsMicros: usd(revenue * 0.05),
          attestHash: attestationHash([event.id]),
          swapTx: sig(),
          burnTx: sig(),
          createdAt: ago(300 - i * 40),
          completedAt: ago(299 - i * 40),
        },
      });
      await prisma.revenueEvent.update({ where: { id: event.id }, data: { buybackId: buyback.id } });
    }

    // The unattested remainder is what `pendingRevenueMicros` claims is queued.
    await prisma.revenueEvent.create({
      data: {
        appId: row.id,
        source: "CHECKOUT",
        usdMicros: usd(pendingUsd),
        payer: fakeAddress(`payer:${app.slug}`),
        reference: "product:pro",
        createdAt: ago(20),
      },
    });

    // BUILD ledger: everything ever credited to the build budget, less what the
    // agent spent. Nets to App.budgetMicros.
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
     * The platform-level accounts are read by /v1/pyre and the ops console, so
     * a seed that writes only BUILD:<app> leaves $PYRE showing $0.00 next to a
     * board advertising thousands in revenue. Mirror the real split: every fee
     * event credits PYRE_TOKEN and the launcher, and every settled buyback
     * credits PYRE_TOKEN and OPS.
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
        {
          account: "PYRE_TOKEN",
          deltaMicros: usd(attestedTotalUsd * 0.1),
          refType: "Buyback",
          refId: row.id,
          memo: `demo: 10% of ${app.ticker} revenue`,
          createdAt: ago(60),
        },
        {
          account: "OPS",
          deltaMicros: usd(attestedTotalUsd * 0.05),
          refType: "Buyback",
          refId: row.id,
          memo: `demo: 5% of ${app.ticker} revenue`,
          createdAt: ago(60),
        },
      ],
    });

    if (!app.dormant) {
      await prisma.promptQueueItem.createMany({
        data: [
          { appId: row.id, authorId: launcher.id, text: "Add a weekly email digest of the top actions.", weight: units(41_200_000) },
          { appId: row.id, authorId: launcher.id, text: "Expose the ranking as a paid x402 endpoint.", weight: units(18_900_000) },
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
