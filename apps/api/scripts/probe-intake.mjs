/**
 * Ops probe: pushes one real app through the intake queue and reports what the
 * runner did with it. Proves the API → Redis → runner → Anthropic → DB → feed
 * wiring, and that a provider failure surfaces as a clean FAILED state with a
 * reason rather than a hung DRAFT.
 *
 * Usage (inside the api container, cwd /repo):
 *   node apps/api/scripts/probe-intake.mjs
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@pyre/db";
import { deriveAppWallet, deriveWallet } from "@pyre/chain";

const SLUG = "probe-intake";
const WAIT_MS = 90_000;

const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const intake = new Queue("intake", { connection: redis });

async function main() {
  await prisma.app.deleteMany({ where: { slug: SLUG } });

  const user = await prisma.user.upsert({
    where: { googleSub: "seed:ops" },
    update: {},
    create: { googleSub: "seed:ops", displayName: "ops", isAdmin: true },
  });
  if (!user.wallet) await prisma.user.update({ where: { id: user.id }, data: { wallet: deriveWallet(user.walletIndex).address } });

  const app = await prisma.app.create({
    data: {
      slug: SLUG,
      name: "Probe Intake",
      ticker: "PROBE",
      imageUrl: "",
      prompt:
        "A one-page tool that converts a CSV of expenses into a categorised monthly summary. Free for one file, $4 USDG to unlock unlimited files.",
      status: "DRAFT",
      launcherId: user.id,
    },
  });

  await prisma.app.update({
    where: { id: app.id },
    data: { walletAddress: deriveAppWallet(app.keypairIndex).address },
  });

  await intake.add("intake", { appId: app.id }, { jobId: `intake-${app.id}` });
  console.log(`queued intake for ${app.id}; waiting up to ${WAIT_MS / 1000}s`);

  const started = Date.now();
  let last = "";
  while (Date.now() - started < WAIT_MS) {
    await new Promise((r) => setTimeout(r, 3000));
    const row = await prisma.app.findUnique({
      where: { id: app.id },
      select: { status: true, spec: true, killedReason: true },
    });
    const events = await prisma.buildEvent.findMany({
      where: { appId: app.id },
      orderBy: { createdAt: "asc" },
      select: { type: true, payload: true },
    });
    const flags = await prisma.abuseFlag.findMany({ where: { appId: app.id }, select: { source: true, category: true, reason: true } });
    const state = JSON.stringify({ status: row?.status, events: events.length });
    if (state !== last) {
      last = state;
      console.log(`status=${row?.status} events=${events.length}`);
    }
    if (row?.status !== "DRAFT") {
      console.log(
        JSON.stringify(
          {
            finalStatus: row?.status,
            hasSpec: Boolean(row?.spec),
            specTitle: row?.spec?.title ?? null,
            events: events.map((e) => ({ type: e.type, text: e.payload?.text ?? null })),
            flags,
            elapsedMs: Date.now() - started,
          },
          null,
          2,
        ),
      );
      return;
    }
  }
  console.log("TIMEOUT: app still DRAFT — intake worker never settled it");
}

main()
  .then(async () => {
    await intake.close();
    await redis.quit();
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await intake.close().catch(() => {});
    await redis.quit().catch(() => {});
    await prisma.$disconnect();
    process.exit(1);
  });
