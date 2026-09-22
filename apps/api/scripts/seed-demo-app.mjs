/**
 * Seeds a LIVE app with a small self-contained deployment, without touching
 * the chain or the agent. Verifies the hosting half of the platform: static
 * serving, env injection, CSP, the QuickJS function runtime, and app kv.
 *
 * Usage (inside the api container, cwd /repo):
 *   node apps/api/scripts/seed-demo-app.mjs <slug>
 *   node apps/api/scripts/seed-demo-app.mjs <slug> --remove
 */
import { createHash } from "node:crypto";
import { prisma } from "@pyre/db";
import { deriveWallet } from "@pyre/chain";

const slug = process.argv[2] ?? "demo";
const remove = process.argv.includes("--remove");

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo — hosting check</title>
    <link rel="stylesheet" href="./assets/app.css" />
  </head>
  <body>
    <main>
      <h1>Hosting check</h1>
      <p id="env">reading platform env…</p>
      <button id="run">call hello()</button>
      <pre id="out">idle</pre>
    </main>
    <script type="module" src="./assets/app.js"></script>
  </body>
</html>
`;

const APP_CSS = `:root { color-scheme: dark }
body { background:#07090b; color:#e6edf3; font:15px/1.5 ui-monospace,Menlo,monospace; margin:0; padding:48px }
h1 { color:#22e07a; font-size:22px; margin:0 0 16px }
button { background:#22e07a; border:0; border-radius:6px; color:#06120b; cursor:pointer; font:inherit; font-weight:700; padding:8px 14px }
pre { background:#0d1117; border:1px solid #1d242c; border-radius:8px; margin-top:16px; padding:12px; white-space:pre-wrap }
`;

const APP_JS = `const env = window.__PYRE__;
document.querySelector("#env").textContent = env
  ? "app " + env.slug + " v" + (env.version ?? "?") + " — functions: " + (env.functions ?? []).map((f) => f.name).join(", ")
  : "window.__PYRE__ missing";
document.querySelector("#run").addEventListener("click", async () => {
  const out = document.querySelector("#out");
  out.textContent = "calling…";
  const res = await fetch("./_pyre/fn/hello", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name: "world" }),
  });
  out.textContent = res.status + " " + (await res.text());
});
`;

const HELLO_FN = `export default async function handler(input, ship) {
  const previous = (await ship.kv.get("calls")) ?? 0;
  const calls = previous + 1;
  await ship.kv.set("calls", calls);
  return { greeting: "hello " + (input?.name ?? "anon"), calls, holder: ship.user.isHolder };
}
`;

const MANIFEST = {
  name: "demo",
  version: "1.0.0",
  entry: "index.html",
  functions: [{ name: "hello", auth: false, holderOnly: false }],
  holderTier: { minHoldTokens: 100000 },
};

const FILES = [
  { path: "index.html", body: Buffer.from(INDEX_HTML), contentType: "text/html; charset=utf-8" },
  { path: "assets/app.css", body: Buffer.from(APP_CSS), contentType: "text/css; charset=utf-8" },
  { path: "assets/app.js", body: Buffer.from(APP_JS), contentType: "text/javascript; charset=utf-8" },
  { path: "functions/hello.js", body: Buffer.from(HELLO_FN), contentType: "text/javascript; charset=utf-8" },
  {
    path: "pyre.manifest.json",
    body: Buffer.from(JSON.stringify(MANIFEST)),
    contentType: "application/json; charset=utf-8",
  },
];

async function main() {
  if (remove) {
    const existing = await prisma.app.findUnique({ where: { slug } });
    if (!existing) {
      console.log(`no app ${slug}`);
      return;
    }
    await prisma.ledgerEntry.deleteMany({ where: { account: { in: [`BUILD:${existing.id}`, `STAKERS:${existing.id}`, `CONTRIB:${existing.id}`, `CREDITS:${existing.id}`] } } });
    await prisma.app.delete({ where: { slug } });
    // The synthetic owner exists only for fixtures; drop it once it owns nothing else, so a
    // production audit leaves no admin user behind.
    const owner = await prisma.user.findUnique({ where: { googleSub: "seed:ops" }, include: { _count: { select: { launches: true } } } });
    if (owner && owner._count.launches === 0) {
      await prisma.ledgerEntry.deleteMany({ where: { account: `LAUNCHER:${owner.id}` } });
      await prisma.user.delete({ where: { id: owner.id } });
    }
    console.log(`removed app ${slug}`);
    return;
  }

  const user = await prisma.user.upsert({
    where: { googleSub: "seed:ops" },
    update: {},
    create: { googleSub: "seed:ops", displayName: "ops", isAdmin: true },
  });
  if (!user.wallet) await prisma.user.update({ where: { id: user.id }, data: { wallet: deriveWallet(user.walletIndex).address } });

  const app = await prisma.app.upsert({
    where: { slug },
    update: { status: "LIVE" },
    create: {
      slug,
      name: "Demo",
      ticker: "DEMO",
      imageUrl: "",
      prompt: "seeded hosting verification app",
      spec: {
        title: "Demo",
        oneLiner: "Hosting verification app seeded by ops.",
        whatItDoes: "Exercises static serving, env injection and the function runtime.",
        mvp: ["serve static files", "run the hello function"],
        outOfScope: [],
        holderTier: { enabled: true, minHoldTokens: 100000, perks: ["pro"] },
        template: "WEB_TOOL",
        risks: [],
      },
      status: "LIVE",
      launcherId: user.id,
      template: "WEB_TOOL",
    },
  });

  const version = app.liveVersion + 1;
  const bundle = Buffer.concat(FILES.map((f) => f.body));
  const deployment = await prisma.deployment.create({
    data: {
      appId: app.id,
      version,
      manifest: MANIFEST,
      bundle,
      bundleSha: createHash("sha256").update(bundle).digest("hex"),
      sizeBytes: bundle.byteLength,
      files: {
        create: FILES.map((f) => ({
          path: f.path,
          contentType: f.contentType,
          body: f.body,
          size: f.body.byteLength,
        })),
      },
    },
  });

  const budgetMicros = 5_000_000n;
  await prisma.app.update({
    where: { id: app.id },
    data: { liveVersion: version, mvpLiveAt: app.mvpLiveAt ?? new Date(), budgetMicros },
  });

  // The BUILD ledger must net to App.budgetMicros or the reconcile LEDGER check
  // reports drift, so credit the seeded budget instead of setting the column alone.
  await prisma.ledgerEntry.deleteMany({ where: { account: `BUILD:${app.id}` } });
  await prisma.ledgerEntry.create({
    data: {
      account: `BUILD:${app.id}`,
      deltaMicros: budgetMicros,
      refType: "FeeEvent",
      refId: app.id,
      memo: "seed: ops verification budget",
    },
  });

  console.log(JSON.stringify({ appId: app.id, slug, version, deploymentId: deployment.id, files: FILES.length }));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
