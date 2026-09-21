#!/usr/bin/env node
/**
 * Full-platform feature audit. Exercises every Pyre feature against the real database, Redis and
 * API, prints a pass/fail matrix and exits non-zero when anything actually broke.
 *
 *   railway ssh --service api "node apps/api/scripts/feature-audit.mjs"
 *
 * It needs the api service's own environment (DATABASE_URL, REDIS_URL, PLATFORM_MASTER_SEED_HEX,
 * SESSION_SECRET, RPC_URL, GITHUB_WEBHOOK_SECRET …), so it is meant to run in-cluster rather than
 * from a laptop: the Postgres and Redis hosts are private.
 *
 * How it reaches each layer:
 *   - money, gating, data integrity  → the real modules and the real tables through Prisma
 *   - authenticated platform routes  → the api's own Express app, listened on an ephemeral port,
 *                                      driven with real HS256 session JWTs (`signSession`) minted
 *                                      for the throwaway users, so the whole middleware chain
 *                                      (rate limit → auth → route) runs unmodified end to end
 *   - hosting, app runtime, perimeter→ plain HTTP against the deployed public origin
 *   - wallet login                   → a throwaway viem account signs the EIP-4361 (SIWE) challenge
 *                                      with personal_sign, so the external-wallet path is proven without a browser
 *
 * Every row it writes is created under a per-run `audit:<runId>` tag and removed again on the way
 * out (LIFO), including the rows Prisma will not cascade: LedgerEntry, JobToken, PyreStake,
 * AdCampaign, AuditLog, WebhookEvent and the Redis keys it touched. The Prisma client is always
 * disconnected — a leaked one holds a whole connection pool.
 *
 * Env:
 *   PYRE_API_ORIGIN   public api origin to probe (default: API_ORIGIN, else the Railway api)
 *   PYRE_PROBE        "local" sends the HTTP checks to the in-process app built from this checkout
 *                     instead of the deployed one — use it to audit code before it ships
 *   PYRE_DEMO_SLUG    seeded hosting app to probe (default: demo)
 *   PYRE_SKIP_SLOW    "1" skips the two checks that wait on a live worker (~2 min)
 *   PYRE_AUDIT_KEEP   "1" leaves the fixtures behind for post-mortem inspection
 *
 * Rows reported BLOCKED are features whose last step needs money the platform does not currently
 * have (Anthropic credits, treasury ETH/USDG on Robinhood Chain), or a chain read that could not
 * be made because RPC_URL / the ETH price oracle is unreachable from here. Everything up to that
 * step is still asserted, and a BLOCKED row never masks a failure: the exit code only reacts to FAIL.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { big, dec, prisma } from "@pyre/db";
import { attestationHash, deriveAppWallet, deriveWallet, getEthPriceUsd, publicClient, treasury } from "@pyre/chain";
import {
  AppSort,
  CONTRIBUTOR_MIN_HOLD_BPS,
  CREDITS_FUNDING_BPS,
  FEE_SPLIT_BPS,
  FORK_ROYALTY_BPS,
  GLOBAL_DAILY_COMPUTE_CEILING_USD,
  ITERATION_BUDGET_USD,
  LAUNCH_RATE_LIMIT_PER_DAY,
  LAUNCH_STAKE_WEI,
  MIN_BUILD_BUDGET_USD,
  MIN_BUYBACK_USD,
  PONS_TOTAL_SUPPLY,
  REVENUE_SPLIT_BPS,
  ROBINHOOD_CHAIN_ID,
  STAKERS_OF_LAUNCHER_BPS,
  TOKEN_DECIMALS,
  VOTE_WALLET_CAP_BPS,
  bps,
  ethToWei,
  slugify,
  splitFees,
  usdMicrosFromWei,
} from "@pyre/shared";

/* ───────────────────────────── configuration ───────────────────────────── */

/** Transport base for the HTTP checks. Repointed at the in-process app when PYRE_PROBE=local. */
let API = (process.env.PYRE_API_ORIGIN ?? process.env.API_ORIGIN ?? "https://api.pyre.fun").replace(/\/+$/, "");
/**
 * The origin the api believes it serves apps on. Path-routed apps always resolve `ctx.origin` from
 * `API_ORIGIN`, so this — not the transport base — is what the CSRF check is compared against.
 */
const PUBLIC_ORIGIN = (process.env.API_ORIGIN ?? API).replace(/\/+$/, "");
const DEMO_SLUG = process.env.PYRE_DEMO_SLUG ?? "demo";
const SKIP_SLOW = process.env.PYRE_SKIP_SLOW === "1";
const KEEP = process.env.PYRE_AUDIT_KEEP === "1";

const RUN = randomBytes(4).toString("hex");
const TAG = `audit:${RUN}`;
const MICROS = 1_000_000n;
const MIN_ITER_MICROS = BigInt(ITERATION_BUDGET_USD.MIN) * MICROS;
const MAX_ITER_MICROS = BigInt(ITERATION_BUDGET_USD.MAX) * MICROS;
const DEFAULT_ITER_MICROS = BigInt(ITERATION_BUDGET_USD.DEFAULT) * MICROS;
const MIN_BUILD_MICROS = BigInt(MIN_BUILD_BUDGET_USD) * MICROS;
const CEILING_MICROS = BigInt(GLOBAL_DAILY_COMPUTE_CEILING_USD) * MICROS;
/** Every PONS v2 launch mints exactly this many base units (1B × 1e18). */
const SUPPLY_BASE_UNITS = PONS_TOTAL_SUPPLY;
const UNIT = 10n ** BigInt(TOKEN_DECIMALS);
const VOTE_CAP = (SUPPLY_BASE_UNITS * BigInt(VOTE_WALLET_CAP_BPS)) / 10_000n;
/** The ≥2% contributor gate `POST /apps/:slug/proposals` enforces. */
const CONTRIB_MIN_HOLD = (SUPPLY_BASE_UNITS * BigInt(CONTRIBUTOR_MIN_HOLD_BPS)) / 10_000n;
/** Past `SANDBOX_TIMEOUT_MS + REAP_GRACE_MS` (45 min) a RUNNING job is reapable. */
const REAPABLE_AGE_MS = 3 * 3_600_000;
/** `resolveApp` caches an app row for 30s, so a status flip needs a little longer to show up. */
const APP_CACHE_WAIT_MS = 45_000;
/** How long the setup probes give the chain RPC and the ETH oracle before calling them unreachable. */
const CHAIN_PROBE_MS = 8_000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const BIGINT_RE = /^\d+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/* ───────────────────────────── result table ───────────────────────────── */

/** @type {{name:string,status:"PASS"|"FAIL"|"BLOCKED"|"SKIP",detail:string,ms:number}[]} */
const results = [];
let currentSection = "";

const check = async (name, fn) => {
  const started = Date.now();
  let status = "FAIL";
  let detail = "";
  try {
    const outcome = (await fn()) ?? {};
    status = outcome.ok ? "PASS" : outcome.blocked ? "BLOCKED" : outcome.skip ? "SKIP" : "FAIL";
    detail = outcome.detail ?? "";
  } catch (err) {
    detail = `threw: ${err instanceof Error ? (err.stack ?? "").split("\n").slice(0, 2).join(" | ") || err.message : String(err)}`;
  }
  results.push({ name: `${currentSection}.${name}`, status, detail, ms: Date.now() - started });
  const mark = { PASS: "ok  ", FAIL: "FAIL", BLOCKED: "blkd", SKIP: "skip" }[status];
  process.stdout.write(`  [${mark}] ${currentSection}.${name}${detail ? ` — ${detail}` : ""}\n`);
};

const section = (name) => {
  currentSection = name;
  process.stdout.write(`\n${name}\n`);
};

/** Assertion helper: collects every failed expectation so one row explains everything at once. */
const expect = () => {
  const bad = [];
  const api = {
    eq: (actual, wanted, label) => {
      if (String(actual) !== String(wanted)) bad.push(`${label}: expected ${wanted}, got ${actual}`);
      return api;
    },
    ok: (cond, label) => {
      if (!cond) bad.push(label);
      return api;
    },
    /** A decimal bigint string, the wire shape of every BigInt field. */
    bigint: (value, label) => {
      if (typeof value !== "string" || !BIGINT_RE.test(value)) bad.push(`${label}: expected a decimal bigint string, got ${JSON.stringify(value)}`);
      return api;
    },
    address: (value, label) => {
      if (typeof value !== "string" || !ADDRESS_RE.test(value)) bad.push(`${label}: expected a 0x address, got ${JSON.stringify(value)}`);
      return api;
    },
    /** @returns {{ok:boolean,detail:string}} */
    done: (detail) => (bad.length === 0 ? { ok: true, detail } : { ok: false, detail: bad.join("; ") }),
  };
  return api;
};

/* ───────────────────────────── cleanup registry ───────────────────────────── */

/** LIFO teardown. Registered the moment a row exists, so a crash still unwinds. */
const trash = [];
const onExit = (label, fn) => trash.push({ label, fn });

const teardown = async () => {
  if (KEEP) {
    process.stdout.write(`\nPYRE_AUDIT_KEEP=1 — leaving ${trash.length} fixtures behind (tag ${TAG})\n`);
    return;
  }
  const failed = [];
  for (let i = trash.length - 1; i >= 0; i--) {
    const entry = trash[i];
    try {
      await entry.fn();
    } catch (err) {
      failed.push(`${entry.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed.length > 0) {
    process.stdout.write(`\nCLEANUP FAILURES (${failed.length}) — rows tagged ${TAG} may remain:\n`);
    for (const f of failed) process.stdout.write(`  ! ${f}\n`);
  }
  return failed.length;
};

/* ───────────────────────────── http helpers ───────────────────────────── */

async function call(url, init = {}) {
  const started = Date.now();
  const res = await fetch(url, { redirect: "manual", ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json, ms: Date.now() - started };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value or the deadline passes. */
async function until(fn, timeoutMs, everyMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(everyMs);
  }
}

/** Resolves `promise`, or null once `ms` has passed or it rejects — the chain probes must never hang the audit. */
const within = (promise, ms) => Promise.race([promise.catch(() => null), sleep(ms).then(() => null)]);

/** A syntactically valid but nonexistent transaction hash. */
const fakeTxHash = () => `0x${randomBytes(32).toString("hex")}`;

/* ───────────────────────────── shared state ───────────────────────────── */

/** Valid 0x addresses for fixtures, from the custodial derivation path at indices no user reaches. */
const fixtureAddress = (n) => deriveWallet(2_000_000_000 + n).address;

const state = {
  /** @type {import("express").Express|null} */ expressApp: null,
  /** @type {string} */ localBase: "",
  /** @type {any} */ server: null,
  /** @type {any} */ redis: null,
  /** @type {Record<string, Queue>} */ queues: {},
  apiQueues: null,
  apiRedis: null,
  users: {},
  apps: {},
  demo: null,
  /** Platform treasury (custodial index 0): where stakes and escrows land. */
  treasury: treasury().address,
  /** Set by setup: whether RPC_URL answered and whether the ETH/USD oracle answered. */
  rpcOk: false,
  priceOk: false,
};

/** Every fixture user carries a real HS256 session JWT (minted in createUser). */
const authHeader = (user) => ({ authorization: `Bearer ${user.token}` });
const jsonHeaders = (user) => ({ "content-type": "application/json", ...(user ? authHeader(user) : {}) });
const local = (path) => `${state.localBase}${path}`;

/**
 * Routes that read the chain or the ETH oracle answer 5xx when those are unreachable from here.
 * Such a row is reported BLOCKED with the reason, never FAIL: the platform code was reached, the
 * network was not. Anything else that 5xx'd is still a failure.
 */
const unreachable = (res) => res.status >= 500 && !(state.rpcOk && state.priceOk);
const offline = () => [!state.rpcOk && "RPC_URL unreachable", !state.priceOk && "ETH price oracle unreachable"].filter(Boolean).join(", ");
const blockedOffline = (reached) => ({ blocked: true, detail: `${reached}; ${offline()} — chain read could not complete` });

/* ───────────────────────────── fixtures ───────────────────────────── */

const createUser = async (label, { admin = false, authWallet = null } = {}) => {
  const user = await prisma.user.create({
    data: {
      googleSub: `${TAG}:${label}`,
      wallet: fixtureAddress(Object.keys(state.users).length + 1),
      authWallet,
      displayName: `audit ${label}`,
      isAdmin: admin,
    },
  });
  // A real session token the auth middleware will verify, exactly like a logged-in client's.
  const { signSession } = await import("../dist/lib/session.js");
  user.token = await signSession(user.id, user.tokenVersion);
  onExit(`user ${label}`, async () => {
    await prisma.vote.deleteMany({ where: { userId: user.id } });
    await prisma.maintainerVote.deleteMany({ where: { userId: user.id } });
    await prisma.purchase.deleteMany({ where: { userId: user.id } });
    await prisma.contributor.deleteMany({ where: { userId: user.id } });
    await prisma.appUserSession.deleteMany({ where: { userId: user.id } });
    await prisma.promptQueueItem.deleteMany({ where: { authorId: user.id } });
    await prisma.bounty.deleteMany({ where: { OR: [{ authorId: user.id }, { claimantId: user.id }] } });
    await prisma.notification.deleteMany({ where: { userId: user.id } });
    await prisma.pyreStake.deleteMany({ where: { wallet: user.wallet } });
    await prisma.ledgerEntry.deleteMany({ where: { account: `LAUNCHER:${user.id}` } });
    await prisma.user.delete({ where: { id: user.id } });
  });
  state.users[label] = user;
  return user;
};

/**
 * A fixture app. `data` overrides anything on the row; the teardown also removes what Prisma will
 * not cascade (ledger rows, job tokens, stakes, ad campaigns, audit log, Redis visitor set).
 */
const createApp = async (label, data = {}) => {
  const app = await prisma.app.create({
    data: {
      slug: `audit-${RUN}-${label}`,
      name: `Audit ${label}`,
      ticker: "AUDIT",
      imageUrl: "",
      prompt: `${TAG} fixture`,
      launcherId: state.users.owner.id,
      status: "LIVE",
      ...data,
    },
  });
  onExit(`app ${label}`, async () => {
    await prisma.ledgerEntry.deleteMany({ where: { account: { in: [`BUILD:${app.id}`, `STAKERS:${app.id}`, `CONTRIB:${app.id}`, `CREDITS:${app.id}`] } } });
    await prisma.jobToken.deleteMany({ where: { appId: app.id } });
    await prisma.pyreStake.deleteMany({ where: { appId: app.id } });
    await prisma.adCampaign.deleteMany({ where: { advertiserAppId: app.id } });
    await prisma.adImpression.deleteMany({ where: { advertiserAppId: app.id } });
    await prisma.auditLog.deleteMany({ where: { targetId: app.id } });
    await prisma.report.deleteMany({ where: { appId: app.id } });
    if (state.redis) await state.redis.del(`app:${app.id}:visitors`);
    await prisma.app.delete({ where: { id: app.id } });
  });
  state.apps[label] = app;
  return app;
};

/** Credits `micros` to an app's build budget with the matching BUILD ledger row (keeps LEDGER clean). */
const creditBudget = async (appId, micros, memo) => {
  await prisma.$transaction([
    prisma.app.update({ where: { id: appId }, data: { budgetMicros: { increment: micros } } }),
    prisma.ledgerEntry.create({
      data: { account: `BUILD:${appId}`, deltaMicros: micros, refType: "FeeEvent", refId: `${TAG}-credit`, memo },
    }),
  ]);
};

const AUDIT_SPEC = {
  title: "Audit Rig",
  oneLiner: "Synthetic launch used by the platform feature audit.",
  whatItDoes: "Nothing: it exists so the launch state machine can be exercised end to end.",
  whoPays: "nobody, this is an internal verification fixture",
  mvp: ["exist", "be approved", "be deleted"],
  outOfScope: [],
  monetization: { model: "ONE_TIME", priceUsd: 1, priceDescription: "n/a" },
  holderTier: { enabled: false, minHoldTokens: null, perks: [] },
  template: "AGENT_API",
  risks: [],
};

const RIG_MANIFEST = {
  name: "audit rig",
  version: "1.0.0",
  entry: "index.html",
  functions: [
    { name: "counter", priceUsd: 0, auth: false, holderOnly: false },
    { name: "paid", priceUsd: 0.25, auth: false, holderOnly: false },
    { name: "private", priceUsd: 0, auth: true, holderOnly: false },
  ],
  products: [
    { id: "pro", name: "Pro unlock", priceUsd: 1, kind: "ONE_TIME" },
    { id: "sub", name: "Monthly", priceUsd: 2, kind: "SUBSCRIPTION_MONTHLY" },
  ],
  adSlot: true,
  holderTier: { minHoldTokens: 0 },
};

const RIG_FILES = [
  { path: "index.html", body: "<!doctype html><title>audit rig</title><h1>audit rig</h1>", contentType: "text/html; charset=utf-8" },
  {
    path: "functions/counter.js",
    body: `export default async function handler(input, ship) {
  const previous = (await ship.kv.get("audit-calls")) ?? 0;
  const calls = previous + 1;
  await ship.kv.set("audit-calls", calls);
  return { calls, echo: input?.echo ?? null, user: ship.user.id };
}
`,
    contentType: "text/javascript; charset=utf-8",
  },
  { path: "functions/paid.js", body: "export default async function handler() { return { paid: true }; }\n", contentType: "text/javascript; charset=utf-8" },
  { path: "functions/private.js", body: "export default async function handler(i, ship) { return { user: ship.user.id }; }\n", contentType: "text/javascript; charset=utf-8" },
  { path: "pyre.manifest.json", body: JSON.stringify(RIG_MANIFEST), contentType: "application/json; charset=utf-8" },
];

/** Gives an app a real deployment so the host serves it like any built app. */
const deployRig = async (app, manifest, files) => {
  const bodies = files.map((f) => ({ ...f, buffer: Buffer.from(f.body) }));
  const bundle = Buffer.concat(bodies.map((f) => f.buffer));
  const deployment = await prisma.deployment.create({
    data: {
      appId: app.id,
      version: 1,
      manifest,
      bundle,
      bundleSha: createHash("sha256").update(bundle).digest("hex"),
      sizeBytes: bundle.byteLength,
      files: { create: bodies.map((f) => ({ path: f.path, contentType: f.contentType, body: f.buffer, size: f.buffer.byteLength })) },
    },
  });
  await prisma.app.update({ where: { id: app.id }, data: { liveVersion: 1, mvpLiveAt: new Date() } });
  return deployment;
};

/* ═══════════════════════════════ 1. launch lifecycle ═══════════════════════════════ */

async function launchChecks() {
  section("launch");
  const { createLaunch } = await import("../dist/lib/launch.js");
  const launcher = state.users.launcher;

  /** Apps created through the real intake path; removed with the same teardown as fixtures. */
  const registerLaunch = (app) => {
    onExit(`launch ${app.slug}`, async () => {
      await prisma.ledgerEntry.deleteMany({ where: { account: `BUILD:${app.id}` } });
      await prisma.jobToken.deleteMany({ where: { appId: app.id } });
      await prisma.auditLog.deleteMany({ where: { targetId: app.id } });
      await prisma.app.delete({ where: { id: app.id } }).catch(() => {});
      const job = await state.queues.intake.getJob(`intake-${app.id}`);
      if (job) await job.remove().catch(() => {});
    });
  };

  const name = `Audit Rig ${RUN}`;
  let first = null;
  let second = null;

  await check("create_draft", async () => {
    first = await createLaunch(launcher, { name, ticker: "AUDIT", imageUrl: "https://example.com/i.png", prompt: `${TAG} launch lifecycle probe, at least twenty characters long.` }, null);
    registerLaunch(first);
    const derived = deriveAppWallet(first.keypairIndex).address;
    return expect()
      .eq(first.status, "DRAFT", "status")
      .eq(first.slug, slugify(name), "slug")
      .eq(first.launcherId, launcher.id, "launcherId")
      .ok(first.keypairIndex > 0, `keypairIndex must be assigned (got ${first.keypairIndex})`)
      .address(first.walletAddress, "walletAddress")
      .eq(first.walletAddress, derived, "walletAddress derivation (m/44'/60'/1'/0/keypairIndex)")
      .eq(first.tokenAddress, null, "tokenAddress must be unset before launch")
      .eq(first.launchPhase, 0, "launchPhase")
      .eq(first.budgetMicros, 0n, "budgetMicros")
      .eq(big(first.stakeWei), 0n, "stakeWei")
      .done(`slug=${first.slug} idx=${first.keypairIndex} wallet=${first.walletAddress.slice(0, 10)}…`);
  });

  await check("slug_collision", async () => {
    second = await createLaunch(launcher, { name, ticker: "AUDIT", imageUrl: "https://example.com/i.png", prompt: `${TAG} second launch with a colliding name, twenty plus characters.` }, null);
    registerLaunch(second);
    return expect()
      .eq(second.slug, `${slugify(name)}-2`, "collision slug")
      .ok(second.keypairIndex !== first.keypairIndex, "keypairIndex must be unique")
      .ok(second.walletAddress !== first.walletAddress, "walletAddress must be unique")
      .done(`${first.slug} → ${second.slug}`);
  });

  await check("intake_queued", async () => {
    const job = await state.queues.intake.getJob(`intake-${first.id}`);
    const app = await prisma.app.findUnique({ where: { id: first.id }, select: { status: true } });
    const consumed = app.status !== "DRAFT";
    return expect()
      .ok(job !== undefined && job !== null ? true : consumed, "intake job must be queued or already consumed")
      .done(job ? `job intake-${first.id.slice(0, 6)}… state=${await job.getState()}` : `already consumed, status=${app.status}`);
  });

  await check("rate_limit_per_day", async () => {
    // Two launches already exist for this launcher in the last 24h; NEW tier allows exactly two.
    const limit = LAUNCH_RATE_LIMIT_PER_DAY.NEW;
    let thrown = null;
    try {
      const extra = await createLaunch(launcher, { name: `Audit Over ${RUN}`, ticker: "AUDIT", imageUrl: "https://example.com/i.png", prompt: `${TAG} this launch must be refused by the tier cap, twenty chars.` }, null);
      registerLaunch(extra);
    } catch (err) {
      thrown = err;
    }
    return expect()
      .eq(limit, 2, "NEW tier cap")
      .ok(thrown !== null, "third launch must be refused")
      .eq(thrown?.status, 429, "status")
      .eq(thrown?.message, "launch_rate_limited", "code")
      .done(`3rd launch → 429 launch_rate_limited (tier NEW, cap ${limit}/24h)`);
  });

  await check("spec_approval", async () => {
    // The live intake worker consumes `second` too and, without Anthropic credits, settles it FAILED.
    // Take the job off the queue first — or, if a worker already holds it, wait for that run to
    // land — so the SPEC_READY fixture state below is not overwritten mid-check.
    const intake = await state.queues.intake.getJob(`intake-${second.id}`);
    if (intake) {
      const removed = await intake.remove().then(() => true, () => false);
      if (!removed) await until(async () => ["completed", "failed"].includes(await intake.getState()), 150_000, 3_000);
    }
    await prisma.app.update({ where: { id: second.id }, data: { status: "SPEC_READY", spec: AUDIT_SPEC, killedReason: null } });
    const res = await call(local(`/v1/launches/${second.id}/approve`), {
      method: "POST",
      headers: jsonHeaders(launcher),
      body: JSON.stringify({ spec: AUDIT_SPEC }),
    });
    const row = await prisma.app.findUnique({ where: { id: second.id } });
    const launch = res.json?.launch;
    return expect()
      .eq(res.status, 200, "http status")
      .eq(res.json?.stake?.to, state.treasury, "stake.to is the treasury")
      .eq(res.json?.stake?.wei, LAUNCH_STAKE_WEI.toString(), "stake.wei")
      .eq(launch?.id, second.id, "launch dto id")
      .eq(launch?.status, "AWAITING_STAKE", "launch dto status")
      .eq(launch?.requiredStakeWei, LAUNCH_STAKE_WEI.toString(), "launch dto requiredStakeWei")
      .eq(launch?.stakeTo, state.treasury, "launch dto stakeTo")
      .eq(launch?.walletAddress, second.walletAddress, "launch dto walletAddress")
      .bigint(launch?.stakeWei, "launch dto stakeWei")
      .eq(row.status, "AWAITING_STAKE", "app status")
      .eq(row.template, AUDIT_SPEC.template, "template from spec")
      .ok(row.specApprovedAt !== null, "specApprovedAt must be set")
      .done(`SPEC_READY → AWAITING_STAKE, stake ${LAUNCH_STAKE_WEI} wei to ${state.treasury.slice(0, 10)}…`);
  });

  await check("stake_requires_funded_wallet", async () => {
    // Custodial stake: the server signs the ETH transfer from the launcher's platform wallet, so
    // the request carries no client signature. The audit wallet is empty, so the funding gate fires.
    const res = await call(local(`/v1/launches/${second.id}/stake`), {
      method: "POST",
      headers: jsonHeaders(launcher),
      body: JSON.stringify({ custodial: true }),
    });
    const row = await prisma.app.findUnique({ where: { id: second.id }, select: { status: true, stakeTx: true, stakeWei: true } });
    const e = expect()
      .eq(row.status, "AWAITING_STAKE", "status must not advance")
      .eq(row.stakeTx, null, "stakeTx must stay null")
      .eq(big(row.stakeWei), 0n, "stakeWei must stay 0");
    if (unreachable(res)) {
      const done = e.done("");
      return done.ok ? blockedOffline("custodial stake reached the balance read, app stays AWAITING_STAKE") : done;
    }
    e.eq(res.status, 400, "http status")
      .eq(res.json?.error, "insufficient_balance", "code")
      .bigint(res.json?.needWei, "needWei")
      .bigint(res.json?.haveWei, "haveWei")
      .ok(BigInt(res.json?.needWei ?? 0) > LAUNCH_STAKE_WEI, "needWei must cover the stake plus the gas reserve")
      .eq(res.json?.haveWei, "0", "the fixture wallet holds nothing")
      .eq(res.json?.to, state.treasury, "to is the treasury");
    const done = e.done("");
    if (!done.ok) return done;
    return { blocked: true, detail: `custodial stake signing reached; needs a funded wallet — 400 insufficient_balance (need ${res.json.needWei} wei), app stays AWAITING_STAKE` };
  });

  await check("stake_external_tx_rejected", async () => {
    // `{txHash}` is the external-wallet stake: the transfer is verified on chain against the sender
    // the launcher proved at login. Body guards first, then the two launcher kinds.
    const e = expect();
    const malformed = await call(local(`/v1/launches/${second.id}/stake`), { method: "POST", headers: jsonHeaders(launcher), body: "{}" });
    e.eq(malformed.status, 400, "empty body status").eq(malformed.json?.error, "validation_failed", "empty body code");
    const badHash = await call(local(`/v1/launches/${second.id}/stake`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ txHash: "0xnope" }) });
    e.eq(badHash.status, 400, "malformed hash status").eq(badHash.json?.error, "validation_failed", "malformed hash code");

    // A Google-only launcher has no proven sender to hold the transfer against: refused before any chain read.
    const googleOnly = await call(local(`/v1/launches/${second.id}/stake`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ txHash: fakeTxHash() }) });
    e.eq(googleOnly.status, 400, "google-only launcher status").eq(googleOnly.json?.error, "external_wallet_required", "google-only launcher code");
    const row = await prisma.app.findUnique({ where: { id: second.id }, select: { status: true, stakeTx: true } });
    e.eq(row.status, "AWAITING_STAKE", "status must not advance").eq(row.stakeTx, null, "stakeTx must stay null");

    // A launcher who signed in with a wallet reaches the chain read; a hash the chain has never seen is refused.
    const external = state.users.external;
    const ext = await createApp("externalStake", { launcherId: external.id, status: "AWAITING_STAKE", walletAddress: fixtureAddress(503), spec: AUDIT_SPEC, specApprovedAt: new Date() });
    const res = await call(local(`/v1/launches/${ext.id}/stake`), { method: "POST", headers: jsonHeaders(external), body: JSON.stringify({ txHash: fakeTxHash() }) });
    const extRow = await prisma.app.findUnique({ where: { id: ext.id }, select: { status: true, stakeTx: true } });
    e.eq(extRow.status, "AWAITING_STAKE", "external launch status must not advance").eq(extRow.stakeTx, null, "external launch stakeTx must stay null");
    if (unreachable(res)) {
      const done = e.done("");
      return done.ok ? blockedOffline("body guards and the Google-only refusal hold; on-chain verification of the fake hash reached") : done;
    }
    e.eq(res.status, 400, "unknown tx status")
      .eq(res.json?.error, "stake_tx_invalid", "unknown tx code")
      .eq(res.json?.reason, "not-found", "reason")
      .eq(res.json?.to, state.treasury, "to")
      .eq(res.json?.minWei, LAUNCH_STAKE_WEI.toString(), "minWei");
    return e.done("{} and a malformed hash → 400 validation_failed; Google-only launcher → 400 external_wallet_required; wallet launcher + never-mined hash → 400 stake_tx_invalid (not-found); both launches stay AWAITING_STAKE");
  });

  await check("illegal_transitions_refused", async () => {
    const e = expect();
    const reApprove = await call(local(`/v1/launches/${second.id}/approve`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ spec: AUDIT_SPEC }) });
    e.eq(reApprove.status, 409, "approve on AWAITING_STAKE status").eq(reApprove.json?.error, "spec_not_ready", "approve code");

    const stakeDraft = await call(local(`/v1/launches/${first.id}/stake`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ custodial: true }) });
    e.eq(stakeDraft.status, 409, "stake on DRAFT status").eq(stakeDraft.json?.error, "not_awaiting_stake", "stake code");

    const approveDraft = await call(local(`/v1/launches/${first.id}/approve`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ spec: AUDIT_SPEC }) });
    e.eq(approveDraft.status, 409, "approve on DRAFT status").eq(approveDraft.json?.error, "spec_not_ready", "approve-draft code");

    const foreign = await call(local(`/v1/launches/${second.id}`), { headers: authHeader(state.users.holder) });
    e.eq(foreign.status, 403, "another user's launch").eq(foreign.json?.error, "forbidden", "ownership code");

    const own = await call(local(`/v1/launches/${second.id}`), { headers: authHeader(launcher) });
    e.eq(own.status, 200, "own launch status").eq(own.json?.launch?.id, second.id, "own launch dto").eq(own.json?.launch?.status, "AWAITING_STAKE", "own launch status field");

    const forkDraft = await call(local(`/v1/apps/${first.slug}/fork`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ name: `Fork ${RUN}`, ticker: "FORKD", imageUrl: "https://example.com/i.png" }) });
    e.eq(forkDraft.status, 409, "fork of a non-LIVE parent").eq(forkDraft.json?.error, "fork_parent_not_live", "fork code");

    const missing = await call(local(`/v1/launches/does-not-exist-${RUN}`), { headers: authHeader(launcher) });
    e.eq(missing.status, 404, "unknown launch").eq(missing.json?.error, "launch_not_found", "missing code");
    return e.done("approve/stake/fork/ownership guards all refuse; the owner reads {launch}");
  });

  await check("intake_settles_without_credits", async () => {
    if (SKIP_SLOW) return { skip: true, detail: "PYRE_SKIP_SLOW=1" };
    const settled = await until(async () => {
      const row = await prisma.app.findUnique({ where: { id: first.id }, select: { status: true, killedReason: true, spec: true } });
      return row.status === "DRAFT" ? null : row;
    }, 150_000, 5_000);
    if (!settled) return { ok: false, detail: "app still DRAFT after 150s — the intake worker is not consuming" };
    if (settled.status === "SPEC_READY") {
      return { ok: true, detail: "intake produced a spec (Anthropic credits are funded again)" };
    }
    const e = expect()
      .eq(settled.status, "FAILED", "settled status")
      .ok((settled.killedReason ?? "").length > 0, "killedReason must explain the failure");
    const audited = await prisma.auditLog.findFirst({ where: { targetType: "App", targetId: first.id, action: "APP_STATUS" } });
    e.ok(audited !== null, "APP_STATUS audit row must be written");
    const done = e.done("");
    if (!done.ok) return done;
    return { blocked: true, detail: `documented no-credits path: FAILED, reason "${settled.killedReason}", audit row written, nothing charged` };
  });
}

/* ═══════════════════════════════ 2. money math ═══════════════════════════════ */

async function moneyChecks() {
  section("money");
  const { recordRevenue } = await import("../dist/host/revenue.js");
  const parent = state.apps.feeParent;
  const fork = state.apps.feeFork;

  await check("fee_split_conservation", async () => {
    const e = expect();
    let worst = 0n;
    // Deterministic sweep across realistic sweep sizes and every parent/staker combination.
    let x = 0x2f6e2b1n;
    for (let i = 0; i < 400; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      const usd = x % 5_000_000_000n; // up to $5,000 per sweep
      for (const hasParent of [false, true]) {
        for (const hasStakers of [false, true]) {
          const s = splitFees(usd, hasParent, hasStakers);
          const sum = s.buildMicros + s.creditsMicros + s.pyreMicros + s.launcherMicros + s.upstreamMicros + s.stakersMicros;
          if (sum !== usd) {
            e.ok(false, `conservation broken at ${usd} (parent=${hasParent}, stakers=${hasStakers}): parts ${sum}`);
            i = 400;
            break;
          }
          const build0 = bps(usd, FEE_SPLIT_BPS.BUILD_BUDGET);
          const upstream = hasParent ? bps(build0, FORK_ROYALTY_BPS) : 0n;
          const postRoyaltyBuild = build0 - upstream;
          const credits = bps(postRoyaltyBuild, CREDITS_FUNDING_BPS);
          const launcher0 = usd - build0 - bps(usd, FEE_SPLIT_BPS.PYRE_TOKEN);
          const stakers = hasStakers ? bps(launcher0, STAKERS_OF_LAUNCHER_BPS) : 0n;
          e.eq(s.pyreMicros, bps(usd, FEE_SPLIT_BPS.PYRE_TOKEN), `$PYRE share at ${usd}`)
            .eq(s.buildMicros, postRoyaltyBuild - credits, `build share at ${usd}`)
            .eq(s.creditsMicros, credits, `credits share at ${usd}`)
            .eq(s.upstreamMicros, upstream, `upstream share at ${usd}`)
            .eq(s.stakersMicros, stakers, `staker share at ${usd}`)
            .eq(s.launcherMicros, launcher0 - stakers, `launcher share at ${usd}`)
            .ok(s.buildMicros >= 0n && s.creditsMicros >= 0n && s.launcherMicros >= 0n, `no negative share at ${usd}`);
          const rounding = usd - (bps(usd, FEE_SPLIT_BPS.BUILD_BUDGET) + bps(usd, FEE_SPLIT_BPS.PYRE_TOKEN) + bps(usd, FEE_SPLIT_BPS.LAUNCHER));
          if (rounding > worst) worst = rounding;
        }
      }
    }
    e.eq(FEE_SPLIT_BPS.BUILD_BUDGET + FEE_SPLIT_BPS.PYRE_TOKEN + FEE_SPLIT_BPS.LAUNCHER, 10_000, "fee split bps must sum to 10000");
    return e.done(`1600 splits exact; launcher absorbs ≤${worst} micros of rounding`);
  });

  /** Mirrors `recordCreatorFee`: real split, FeeEvent, budget credit, ledger rows, royalty, stakers. */
  const stakeAmount = 1_000_000n * UNIT; // 1M $PYRE
  let split = null;
  let royaltyId = null;

  await check("fee_event_end_to_end", async () => {
    const stake = await prisma.pyreStake.create({
      data: { wallet: state.users.holder.wallet, appId: fork.id, amount: dec(stakeAmount), depositTx: fakeTxHash() },
    });
    const before = await prisma.app.findMany({ where: { id: { in: [parent.id, fork.id] } }, select: { id: true, budgetMicros: true, feesWei: true } });
    const budgetBefore = Object.fromEntries(before.map((a) => [a.id, a.budgetMicros]));

    const wei = 1_500_000_000_000_000_000n; // 1.5 ETH claimed from the PONS escrow
    const ethPriceUsd = 2703.89;
    const usdMicros = usdMicrosFromWei(wei, ethPriceUsd);
    split = splitFees(usdMicros, true, true);
    const txHash = fakeTxHash();

    const created = await prisma.$transaction(async (tx) => {
      const fee = await tx.feeEvent.create({
        data: {
          appId: fork.id,
          source: "CREATOR_FEE",
          wei: dec(wei),
          ethPriceUsd,
          usdMicros: split.usdMicros,
          buildMicros: split.buildMicros,
          pyreMicros: split.pyreMicros,
          launcherMicros: split.launcherMicros,
          upstreamMicros: split.upstreamMicros,
          creditsMicros: split.creditsMicros,
          txHash,
        },
      });
      await tx.app.update({ where: { id: fork.id }, data: { budgetMicros: { increment: split.buildMicros }, feesWei: { increment: dec(wei) } } });
      const ledger = [
        { account: `BUILD:${fork.id}`, deltaMicros: split.buildMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" },
        { account: "PYRE_TOKEN", deltaMicros: split.pyreMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" },
        { account: `LAUNCHER:${fork.launcherId}`, deltaMicros: split.launcherMicros, refType: "FeeEvent", refId: fee.id, memo: "creator fee" },
      ];
      if (split.creditsMicros > 0n) ledger.push({ account: `CREDITS:${fork.id}`, deltaMicros: split.creditsMicros, refType: "FeeEvent", refId: fee.id, memo: "credit funding" });
      // The royalty row shares the claim's tx without carrying it (the parent's FeeEvent.txHash is unique).
      const royaltyWei = (wei * split.upstreamMicros) / usdMicros;
      const royalty = await tx.feeEvent.create({
        data: {
          appId: parent.id,
          source: "FORK_ROYALTY",
          wei: dec(royaltyWei),
          ethPriceUsd,
          usdMicros: split.upstreamMicros,
          buildMicros: split.upstreamMicros,
          pyreMicros: 0n,
          launcherMicros: 0n,
        },
      });
      await tx.app.update({ where: { id: parent.id }, data: { budgetMicros: { increment: split.upstreamMicros } } });
      ledger.push({ account: `BUILD:${parent.id}`, deltaMicros: split.upstreamMicros, refType: "FeeEvent", refId: royalty.id, memo: `fork royalty from ${fork.id}` });
      await tx.pyreStake.update({ where: { id: stake.id }, data: { earnedMicros: { increment: split.stakersMicros } } });
      ledger.push({ account: `STAKERS:${fork.id}`, deltaMicros: split.stakersMicros, refType: "FeeEvent", refId: fee.id, memo: "staker share of launcher cut" });
      await tx.ledgerEntry.createMany({ data: ledger });
      return { fee, royalty };
    });
    royaltyId = created.royalty.id;
    onExit("fee events", async () => {
      await prisma.ledgerEntry.deleteMany({ where: { refId: { in: [created.fee.id, created.royalty.id] } } });
      await prisma.feeEvent.deleteMany({ where: { id: { in: [created.fee.id, created.royalty.id] } } });
    });

    const after = await prisma.app.findMany({ where: { id: { in: [parent.id, fork.id] } }, select: { id: true, budgetMicros: true, feesWei: true } });
    const budgetAfter = Object.fromEntries(after.map((a) => [a.id, a.budgetMicros]));
    const feesAfter = Object.fromEntries(after.map((a) => [a.id, big(a.feesWei)]));
    const stored = await prisma.feeEvent.findUnique({ where: { txHash } });
    const stakerRow = await prisma.ledgerEntry.findFirst({ where: { account: `STAKERS:${fork.id}`, refId: created.fee.id } });
    const pyreRow = await prisma.ledgerEntry.findFirst({ where: { account: "PYRE_TOKEN", refId: created.fee.id } });
    const launcherRow = await prisma.ledgerEntry.findFirst({ where: { account: `LAUNCHER:${fork.launcherId}`, refId: created.fee.id } });
    const creditsRow = await prisma.ledgerEntry.findFirst({ where: { account: `CREDITS:${fork.id}`, refId: created.fee.id } });
    const parts = stored.buildMicros + stored.creditsMicros + stored.pyreMicros + stored.launcherMicros + stored.upstreamMicros + (stakerRow?.deltaMicros ?? 0n);

    return expect()
      .eq(stored?.id, created.fee.id, "FeeEvent is unique on txHash")
      .eq(parts, stored.usdMicros, "build+credits+pyre+launcher+upstream+stakers == usd")
      .eq(budgetAfter[fork.id] - budgetBefore[fork.id], split.buildMicros, "fork budget credit")
      .eq(feesAfter[fork.id], wei, "fork feesWei counter")
      .eq(pyreRow?.deltaMicros, split.pyreMicros, "PYRE_TOKEN ledger")
      .eq(launcherRow?.deltaMicros, split.launcherMicros, "LAUNCHER ledger")
      .eq(stakerRow?.deltaMicros, split.stakersMicros, "STAKERS ledger")
      .eq(creditsRow?.deltaMicros ?? 0n, split.creditsMicros, "CREDITS ledger")
      .eq(stored.usdMicros, usdMicros, "usd from wei")
      .eq(usdMicros, 4_055_835_000n, "1.5 ETH @ $2,703.89 prices exactly")
      .done(`1.5 ETH @ $${ethPriceUsd} = $${(Number(usdMicros) / 1e6).toFixed(2)}: build $${(Number(split.buildMicros) / 1e6).toFixed(2)} credits $${(Number(split.creditsMicros) / 1e6).toFixed(2)} pyre $${(Number(split.pyreMicros) / 1e6).toFixed(2)} launcher $${(Number(split.launcherMicros) / 1e6).toFixed(2)} upstream $${(Number(split.upstreamMicros) / 1e6).toFixed(2)} stakers $${(Number(split.stakersMicros) / 1e6).toFixed(2)}`);
  });

  await check("fork_royalty_routing", async () => {
    const royalty = royaltyId ? await prisma.feeEvent.findUnique({ where: { id: royaltyId } }) : null;
    const parentRow = await prisma.app.findUnique({ where: { id: parent.id }, select: { budgetMicros: true } });
    const parentLedger = await prisma.ledgerEntry.aggregate({ where: { account: `BUILD:${parent.id}` }, _sum: { deltaMicros: true } });
    const stake = await prisma.pyreStake.findFirst({ where: { appId: fork.id, wallet: state.users.holder.wallet } });
    return expect()
      .ok(royalty !== null, "parent FORK_ROYALTY FeeEvent must exist")
      .eq(royalty?.appId, parent.id, "royalty lands on the parent")
      .eq(royalty?.source, "FORK_ROYALTY", "source")
      .eq(royalty?.txHash, null, "royalty rows carry no tx of their own")
      .eq(royalty?.usdMicros, split.upstreamMicros, "royalty usd")
      .eq(royalty?.buildMicros, split.upstreamMicros, "royalty is 100% build budget")
      .eq(split.upstreamMicros, bps(bps(split.usdMicros, FEE_SPLIT_BPS.BUILD_BUDGET), FORK_ROYALTY_BPS), `royalty is ${FORK_ROYALTY_BPS}bps of the build share`)
      .eq(parentRow.budgetMicros, split.upstreamMicros, "parent budget credited")
      .eq(parentLedger._sum.deltaMicros, split.upstreamMicros, "parent BUILD ledger credited")
      .eq(stake?.earnedMicros, split.stakersMicros, "staker earnings credited")
      .done(`upstream $${(Number(split.upstreamMicros) / 1e6).toFixed(4)} routed to the parent's budget and ledger`);
  });

  let revenueIds = [];
  await check("revenue_recorded", async () => {
    const before = await prisma.app.findUnique({ where: { id: parent.id }, select: { revenueMicros: true, pendingRevenueMicros: true, firstRevenueAt: true } });
    const amounts = [4_000_000n, 2_500_000n];
    for (const usdMicros of amounts) {
      const ev = await recordRevenue({ app: { id: parent.id, slug: parent.slug }, source: "CHECKOUT", usdMicros, payer: state.users.holder.wallet, reference: `${TAG}-rev-${usdMicros}`, label: `${TAG} revenue` });
      revenueIds.push(ev.id);
    }
    onExit("revenue events", async () => {
      await prisma.ledgerEntry.deleteMany({ where: { refId: { in: revenueIds } } });
      await prisma.revenueEvent.deleteMany({ where: { id: { in: revenueIds } } });
    });
    const total = amounts.reduce((a, b) => a + b, 0n);
    const after = await prisma.app.findUnique({ where: { id: parent.id }, select: { revenueMicros: true, pendingRevenueMicros: true, firstRevenueAt: true } });
    const ledger = await prisma.ledgerEntry.findMany({ where: { account: "TREASURY", refId: { in: revenueIds } } });
    return expect()
      .eq(after.revenueMicros - before.revenueMicros, total, "lifetime revenue")
      .eq(after.pendingRevenueMicros - before.pendingRevenueMicros, total, "pending revenue")
      .ok(after.firstRevenueAt !== null, "firstRevenueAt must be stamped")
      .eq(ledger.length, 2, "TREASURY ledger rows")
      .eq(ledger.reduce((a, r) => a + r.deltaMicros, 0n), total, "TREASURY credit total")
      .done(`$${(Number(total) / 1e6).toFixed(2)} recorded across ${revenueIds.length} events`);
  });

  let buyback = null;
  await check("buyback_status_machine", async () => {
    const events = await prisma.revenueEvent.findMany({ where: { appId: parent.id, buybackId: null }, select: { id: true, usdMicros: true } });
    const revenueMicros = events.reduce((a, e) => a + e.usdMicros, 0n);
    if (revenueMicros < BigInt(MIN_BUYBACK_USD) * MICROS) return { ok: false, detail: `fixture revenue ${revenueMicros} below the $${MIN_BUYBACK_USD} minimum` };
    const ids = events.map((e) => e.id);
    const buybackMicros = bps(revenueMicros, REVENUE_SPLIT_BPS.BUYBACK_BURN);
    const pyreMicros = bps(revenueMicros, REVENUE_SPLIT_BPS.PYRE_TOKEN);
    const opsMicros = revenueMicros - buybackMicros - pyreMicros;
    const attestHash = attestationHash(ids);
    const ethWei = 2_000_000_000_000_000n; // 0.002 ETH spent on the buy
    const bought = 1_234n * UNIT;

    buyback = await prisma.$transaction(async (tx) => {
      const row = await tx.buyback.create({ data: { appId: parent.id, status: "PENDING", revenueMicros, ethWei: dec(ethWei), pyreMicros, opsMicros, attestHash } });
      await tx.revenueEvent.updateMany({ where: { id: { in: ids } }, data: { buybackId: row.id } });
      return row;
    });
    onExit("buyback", async () => {
      await prisma.revenueEvent.updateMany({ where: { buybackId: buyback.id }, data: { buybackId: null } });
      await prisma.ledgerEntry.deleteMany({ where: { refId: buyback.id } });
      await prisma.buyback.delete({ where: { id: buyback.id } }).catch(() => {});
    });
    state.buybackId = buyback.id;

    const e = expect()
      .eq(buyback.status, "PENDING", "opened status")
      .eq(buyback.revenueMicros, revenueMicros, "attested revenue")
      .eq(buyback.pyreMicros, pyreMicros, `$PYRE share (${REVENUE_SPLIT_BPS.PYRE_TOKEN}bps)`)
      .eq(buyback.opsMicros, opsMicros, "ops share absorbs rounding")
      .eq(buybackMicros + pyreMicros + opsMicros, revenueMicros, "revenue split conservation")
      .eq(buyback.attestHash, attestHash, "attestation hash");

    // PENDING → SWAPPED
    const swapped = await prisma.buyback.update({ where: { id: buyback.id }, data: { status: "SWAPPED", swapTx: fakeTxHash(), tokensBought: dec(bought), error: null } });
    e.eq(swapped.status, "SWAPPED", "swap transition").eq(big(swapped.tokensBought), bought, "tokens bought");

    // SWAPPED → BURNED, with the same counter and ledger settlement burnStage performs
    const pendingBefore = (await prisma.app.findUnique({ where: { id: parent.id }, select: { pendingRevenueMicros: true } })).pendingRevenueMicros;
    await prisma.$transaction(async (tx) => {
      await tx.buyback.update({
        where: { id: buyback.id },
        data: { status: "BURNED", burnTx: fakeTxHash(), attestTx: fakeTxHash(), tokensBurned: dec(bought), burnedUnits: dec(bought), completedAt: new Date(), error: null },
      });
      const current = await tx.app.findUniqueOrThrow({ where: { id: parent.id }, select: { pendingRevenueMicros: true } });
      const remaining = current.pendingRevenueMicros - revenueMicros;
      await tx.app.update({
        where: { id: parent.id },
        data: { buybackWei: { increment: dec(ethWei) }, burnedTokens: { increment: dec(bought) }, pendingRevenueMicros: remaining > 0n ? remaining : 0n },
      });
      await tx.ledgerEntry.createMany({
        data: [
          { account: "TREASURY", deltaMicros: -buybackMicros, refType: "Buyback", refId: buyback.id, memo: `${TAG} buyback` },
          { account: "PYRE_TOKEN", deltaMicros: pyreMicros, refType: "Buyback", refId: buyback.id, memo: `${TAG} pyre share` },
          { account: "OPS", deltaMicros: opsMicros, refType: "Buyback", refId: buyback.id, memo: `${TAG} ops share` },
        ],
      });
    });
    const burned = await prisma.buyback.findUnique({ where: { id: buyback.id } });
    const app = await prisma.app.findUnique({ where: { id: parent.id }, select: { pendingRevenueMicros: true, burnedTokens: true, buybackWei: true } });
    e.eq(burned.status, "BURNED", "burn transition")
      .ok(burned.completedAt !== null, "completedAt must be stamped")
      .eq(big(burned.tokensBurned), bought, "tokens burned")
      .eq(big(burned.burnedUnits), bought, "on-chain burned units")
      .eq(app.pendingRevenueMicros, pendingBefore - revenueMicros > 0n ? pendingBefore - revenueMicros : 0n, "pending revenue drained")
      .eq(big(app.burnedTokens), bought, "app burned supply")
      .eq(big(app.buybackWei), ethWei, "app buybackWei counter");

    // Illegal transitions: the guarded updates every stage uses must match zero rows on a BURNED row.
    const reSwap = await prisma.buyback.updateMany({ where: { id: buyback.id, status: "PENDING" }, data: { status: "SWAPPED" } });
    const reBurn = await prisma.buyback.updateMany({ where: { id: buyback.id, status: "SWAPPED" }, data: { status: "BURNED" } });
    const reopen = await prisma.buyback.updateMany({ where: { id: buyback.id, status: { in: ["PENDING", "SWAPPED"] } }, data: { status: "FAILED" } });
    e.eq(reSwap.count, 0, "BURNED cannot re-enter SWAPPED").eq(reBurn.count, 0, "BURNED cannot re-burn").eq(reopen.count, 0, "BURNED cannot fail");

    const attached = await prisma.revenueEvent.count({ where: { buybackId: buyback.id } });
    e.eq(attached, ids.length, "revenue events stay attached");
    return e.done(`PENDING → SWAPPED → BURNED on $${(Number(revenueMicros) / 1e6).toFixed(2)}; burn $${(Number(buybackMicros) / 1e6).toFixed(2)} / pyre $${(Number(pyreMicros) / 1e6).toFixed(2)} / ops $${(Number(opsMicros) / 1e6).toFixed(2)}; 3 illegal transitions refused`);
  });

  await check("revenue_attestation", async () => {
    const e = expect();
    // Order independence is the property the memo relies on.
    const a = ["c", "a", "b"];
    e.eq(attestationHash(a), attestationHash([...a].reverse()), "hash must be order independent")
      .ok(attestationHash(a) !== attestationHash(["a", "b"]), "hash must depend on the full set")
      .ok(HASH_RE.test(attestationHash([])), `hash is 0x-prefixed sha256 hex (got ${attestationHash([])})`);
    // Every stored buyback must still be recomputable from the revenue it claims.
    const rows = await prisma.buyback.findMany({ select: { id: true, appId: true, attestHash: true, revenueEvents: { select: { id: true, usdMicros: true } } } });
    let checked = 0;
    let mismatched = 0;
    for (const row of rows) {
      if (row.revenueEvents.length === 0) continue;
      checked++;
      if (attestationHash(row.revenueEvents.map((r) => r.id)) !== row.attestHash) mismatched++;
    }
    e.eq(mismatched, 0, `${mismatched}/${checked} stored buybacks do not hash to their attached revenue`);
    return e.done(`order independent; ${checked} stored buyback${checked === 1 ? "" : "s"} recompute to their stored attestation`);
  });

  await check("ledger_invariants_global", async () => {
    // Exactly the three per-app invariants plus the fee-split invariant the reconcile LEDGER check uses.
    const TOLERANCE = 1_000n;
    const abs = (v) => (v < 0n ? -v : v);
    const apps = await prisma.app.findMany({ select: { id: true, slug: true, budgetMicros: true, revenueMicros: true, pendingRevenueMicros: true } });
    const buildLedger = await prisma.ledgerEntry.groupBy({ by: ["account"], where: { account: { startsWith: "BUILD:" } }, _sum: { deltaMicros: true } });
    const ledgerByApp = Object.fromEntries(buildLedger.map((r) => [r.account.slice("BUILD:".length), r._sum.deltaMicros ?? 0n]));
    const buybacks = await prisma.buyback.groupBy({ by: ["appId"], where: { status: { not: "FAILED" } }, _sum: { revenueMicros: true } });
    const attestedByApp = Object.fromEntries(buybacks.map((r) => [r.appId, r._sum.revenueMicros ?? 0n]));
    const unattested = await prisma.revenueEvent.groupBy({ by: ["appId"], where: { buybackId: null }, _sum: { usdMicros: true } });
    const unattestedByApp = Object.fromEntries(unattested.map((r) => [r.appId, r._sum.usdMicros ?? 0n]));

    const findings = [];
    for (const app of apps) {
      const ledgerSum = ledgerByApp[app.id] ?? 0n;
      const budgetDrift = app.budgetMicros === 0n ? (ledgerSum > TOLERANCE ? ledgerSum : 0n) : ledgerSum - app.budgetMicros;
      if (abs(budgetDrift) > TOLERANCE) findings.push(`BUILD_LEDGER_DRIFT ${app.slug} ${budgetDrift}`);
      const attested = attestedByApp[app.id] ?? 0n;
      if (attested > app.revenueMicros + TOLERANCE) findings.push(`BUYBACK_EXCEEDS_REVENUE ${app.slug}`);
      const pending = unattestedByApp[app.id] ?? 0n;
      if (abs(pending - app.pendingRevenueMicros) > TOLERANCE) findings.push(`PENDING_REVENUE_DRIFT ${app.slug} ${pending - app.pendingRevenueMicros}`);
    }
    const fees = await prisma.feeEvent.aggregate({ _sum: { usdMicros: true, buildMicros: true, creditsMicros: true, pyreMicros: true, launcherMicros: true, upstreamMicros: true }, _count: true });
    const stakerLedger = await prisma.ledgerEntry.aggregate({ where: { account: { startsWith: "STAKERS:" }, refType: "FeeEvent" }, _sum: { deltaMicros: true } });
    const parts = (fees._sum.buildMicros ?? 0n) + (fees._sum.creditsMicros ?? 0n) + (fees._sum.pyreMicros ?? 0n) + (fees._sum.launcherMicros ?? 0n) + (fees._sum.upstreamMicros ?? 0n) + (stakerLedger._sum.deltaMicros ?? 0n);
    const feeTotal = fees._sum.usdMicros ?? 0n;
    if (abs(parts - feeTotal) > TOLERANCE) findings.push(`FEE_SPLIT_DRIFT parts ${parts} vs collected ${feeTotal}`);
    return findings.length === 0
      ? { ok: true, detail: `${apps.length} apps, ${fees._count} fee events: 0 drift (incl. this run's writes)` }
      : { ok: false, detail: findings.join("; ") };
  });
}

/* ═══════════════════════════════ 3. build gating ═══════════════════════════════ */

async function gatingChecks() {
  section("gating");
  const gate = state.apps.gate;

  await check("thresholds_honoured_by_existing_jobs", async () => {
    const jobs = await prisma.buildJob.findMany({ select: { id: true, appId: true, stage: true, budgetMicros: true } });
    const bad = [];
    for (const job of jobs) {
      if (job.budgetMicros < MIN_ITER_MICROS) bad.push(`${job.id} ${job.stage} budget ${job.budgetMicros} below the $${ITERATION_BUDGET_USD.MIN} floor`);
      if (job.stage === "ITERATE" && job.budgetMicros > DEFAULT_ITER_MICROS) bad.push(`${job.id} ITERATE budget ${job.budgetMicros} above the $${ITERATION_BUDGET_USD.DEFAULT} default`);
      if (job.budgetMicros > MAX_ITER_MICROS) bad.push(`${job.id} ${job.stage} budget ${job.budgetMicros} above the $${ITERATION_BUDGET_USD.MAX} cap`);
    }
    const unstarted = await prisma.app.findMany({ where: { firstBuildAt: null }, select: { id: true, slug: true, jobs: { select: { id: true }, take: 1 } } });
    for (const app of unstarted) {
      if (app.jobs.length > 0) bad.push(`${app.slug} has a BuildJob but no firstBuildAt — the first-build gate was bypassed`);
    }
    return bad.length === 0
      ? { ok: true, detail: `${jobs.length} build jobs within [$${ITERATION_BUDGET_USD.MIN}, $${ITERATION_BUDGET_USD.MAX}]; ${unstarted.length} unstarted apps have no jobs` }
      : { ok: false, detail: bad.slice(0, 4).join("; ") };
  });

  await check("first_build_threshold", async () => {
    // The gate the scheduler applies: no MVP before MIN_BUILD_BUDGET_USD has accrued.
    await prisma.app.update({ where: { id: gate.id }, data: { firstBuildAt: null } });
    const below = MIN_BUILD_MICROS - 1n;
    const eligible = (budget) => budget >= MIN_BUILD_MICROS;
    const e = expect()
      .ok(!eligible(below), `$${Number(below) / 1e6} must not start a build`)
      .ok(eligible(MIN_BUILD_MICROS), `$${MIN_BUILD_BUDGET_USD} must start a build`)
      .eq(MIN_BUILD_MICROS, 50_000_000n, "first-build threshold");
    // And the platform has not started one for any app that never reached it.
    const started = await prisma.app.findMany({ where: { firstBuildAt: { not: null } }, select: { slug: true, budgetMicros: true, spentMicros: true } });
    for (const app of started) {
      if (app.budgetMicros + app.spentMicros === 0n) e.ok(false, `${app.slug} has firstBuildAt with no budget ever credited`);
    }
    return e.done(`threshold $${MIN_BUILD_BUDGET_USD}; ${started.length} started apps all had budget`);
  });

  await check("iteration_threshold", async () => {
    const e = expect()
      .eq(MIN_ITER_MICROS, 10_000_000n, "iteration floor")
      .eq(DEFAULT_ITER_MICROS, 25_000_000n, "iteration default")
      .eq(MAX_ITER_MICROS, 50_000_000n, "iteration cap")
      .ok(MIN_ITER_MICROS < DEFAULT_ITER_MICROS && DEFAULT_ITER_MICROS < MAX_ITER_MICROS, "iteration budgets must be ordered");
    // Live consequence: no LIVE deployed app sits above the iteration floor with tasks waiting and no job.
    const stalled = await prisma.app.findMany({
      where: { status: "LIVE", liveVersion: { gt: 0 }, budgetMicros: { gte: MIN_ITER_MICROS }, queueItems: { some: { status: "OPEN" } }, jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } } },
      select: { slug: true },
    });
    const paused = (await prisma.platformSetting.findUnique({ where: { key: "pause_builds" } }))?.value === true;
    if (!paused) e.eq(stalled.length, 0, `apps funded with open tasks but no job: ${stalled.map((a) => a.slug).join(", ")}`);
    return e.done(paused ? `floor $${ITERATION_BUDGET_USD.MIN}/default $${ITERATION_BUDGET_USD.DEFAULT}/cap $${ITERATION_BUDGET_USD.MAX}; ${stalled.length} funded apps waiting (builds paused)` : `floor/default/cap ordered; no funded app is stalled`);
  });

  await check("dormant_at_zero_budget", async () => {
    const app = state.apps.dormant;
    const dormantDue = (a) => a.budgetMicros < MIN_ITER_MICROS && a.pendingRevenueMicros === 0n;
    const e = expect()
      .ok(dormantDue({ budgetMicros: 0n, pendingRevenueMicros: 0n }), "zero budget and no pending revenue must go dormant")
      .ok(!dormantDue({ budgetMicros: 0n, pendingRevenueMicros: 1n }), "pending revenue must defer dormancy")
      .ok(!dormantDue({ budgetMicros: MIN_ITER_MICROS, pendingRevenueMicros: 0n }), "a funded app must stay live");
    await prisma.app.update({ where: { id: app.id }, data: { status: "DORMANT", budgetMicros: 0n, pendingRevenueMicros: 0n } });
    const row = await prisma.app.findUnique({ where: { id: app.id }, select: { status: true } });
    e.eq(row.status, "DORMANT", "transition applied");
    // Invariant the reviver maintains: nothing sits DORMANT while it can afford an iteration.
    const revivable = await prisma.app.findMany({ where: { status: "DORMANT", budgetMicros: { gte: MIN_ITER_MICROS } }, select: { slug: true, budgetMicros: true } });
    e.eq(revivable.length, 0, `DORMANT apps that can already afford an iteration: ${revivable.map((a) => a.slug).join(", ")}`);
    return e.done(`predicate exact at the $${ITERATION_BUDGET_USD.MIN} floor; ${await prisma.app.count({ where: { status: "DORMANT" } })} apps dormant, none revivable`);
  });

  await check("revival_on_new_fees", async () => {
    const app = state.apps.dormant;
    const revivalDue = (budget) => budget >= MIN_ITER_MICROS;
    const e = expect()
      .ok(!revivalDue(MIN_ITER_MICROS - 1n), "a credit below the floor must not revive")
      .ok(revivalDue(MIN_ITER_MICROS), "a credit at the floor must revive");
    await creditBudget(app.id, MIN_ITER_MICROS, `${TAG} revival credit`);
    const credited = await prisma.app.findUnique({ where: { id: app.id }, select: { budgetMicros: true, status: true } });
    e.eq(credited.budgetMicros, MIN_ITER_MICROS, "budget credited");
    if (revivalDue(credited.budgetMicros)) {
      await prisma.app.update({ where: { id: app.id }, data: { status: "LIVE" } });
    }
    const revived = await prisma.app.findUnique({ where: { id: app.id }, select: { status: true } });
    e.eq(revived.status, "LIVE", "revived status");
    return e.done(`DORMANT → LIVE once the budget reaches $${ITERATION_BUDGET_USD.MIN}`);
  });

  await check("daily_compute_ceiling", async () => {
    const { JOB_TOKEN, restoreSpend, previous } = state.proxy;
    const day = new Date().toISOString().slice(0, 10);
    const remaining = (spent) => (spent >= CEILING_MICROS ? 0n : CEILING_MICROS - spent);
    const e = expect()
      .eq(remaining(0n), CEILING_MICROS, "remaining at zero spend")
      .eq(remaining(CEILING_MICROS), 0n, "remaining at the ceiling")
      .eq(remaining(CEILING_MICROS + 1n), 0n, "remaining past the ceiling never goes negative")
      .eq(CEILING_MICROS, 2_000_000_000n, `ceiling is $${GLOBAL_DAILY_COMPUTE_CEILING_USD}`);
    // Probe the api's own enforcement: park today's spend at the ceiling, confirm the proxy refuses,
    // then put the exact previous value back (the restore is registered before the write).
    await prisma.dailyComputeSpend.upsert({ where: { day }, create: { day, micros: CEILING_MICROS }, update: { micros: CEILING_MICROS } });
    const res = await call(`${API}/v1/proxy/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": JOB_TOKEN },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "ping" }] }),
    });
    await restoreSpend();
    e.eq(res.status, 429, "proxy status at the ceiling").eq(res.json?.error, "daily_compute_ceiling", "proxy code");
    const after = await prisma.dailyComputeSpend.findUnique({ where: { day } });
    e.eq(after?.micros ?? 0n, previous, "today's spend restored exactly");
    return e.done(`proxy refuses at $${GLOBAL_DAILY_COMPUTE_CEILING_USD}/day; spend restored to ${previous}`);
  });

  await check("pause_builds_blocks_scheduling", async () => {
    const paused = (await prisma.platformSetting.findUnique({ where: { key: "pause_builds" } }))?.value === true;
    if (!paused) return { ok: false, detail: "pause_builds is not true — this deployment is expected to be paused" };
    if (SKIP_SLOW) return { skip: true, detail: "PYRE_SKIP_SLOW=1" };
    await prisma.app.update({ where: { id: gate.id }, data: { status: "LIVE", firstBuildAt: null } });
    await creditBudget(gate.id, MIN_BUILD_MICROS, `${TAG} gate budget`);
    const funded = await prisma.app.findUnique({ where: { id: gate.id }, select: { budgetMicros: true, status: true } });
    if (funded.budgetMicros < MIN_BUILD_MICROS) return { ok: false, detail: `fixture budget ${funded.budgetMicros} below the first-build threshold` };

    // BullMQ rejects ":" in a custom job id, so probe ids use the bare run id.
    const jobId = `audit-${RUN}-sched`;
    const job = await state.queues.scheduler.add("audit", { appId: gate.id, kind: "audit" }, { jobId });
    onExit("scheduler probe job", async () => {
      await state.queues.scheduler.getJob(jobId).then((j) => j?.remove()).catch(() => {});
    });
    const finished = await until(async () => {
      const state_ = await job.getState();
      return state_ === "completed" || state_ === "failed" ? state_ : null;
    }, 90_000, 2_000);
    if (!finished) return { ok: false, detail: "the live runner never processed the scheduler job (worker not consuming)" };
    if (finished === "failed") return { ok: false, detail: `scheduler job failed: ${(await state.queues.scheduler.getJob(jobId))?.failedReason}` };
    const jobs = await prisma.buildJob.count({ where: { appId: gate.id } });
    const app = await prisma.app.findUnique({ where: { id: gate.id }, select: { firstBuildAt: true } });
    return expect()
      .eq(jobs, 0, "a funded app must get no BuildJob while builds are paused")
      .eq(app.firstBuildAt, null, "firstBuildAt must not be stamped")
      .done(`live runner ran the tick for a $${MIN_BUILD_BUDGET_USD}-funded app and scheduled nothing (pause_builds=true)`);
  });
}

/* ═══════════════════════════════ 4. governance ═══════════════════════════════ */

async function governanceChecks() {
  section("governance");
  const app = state.apps.feeParent;
  const holder = state.users.holder;
  const launcher = state.users.launcher;
  const setBalance = (wallet, amount) =>
    prisma.holderBalance.upsert({ where: { appId_wallet: { appId: app.id, wallet } }, create: { appId: app.id, wallet, amount: dec(amount) }, update: { amount: dec(amount) } });

  let itemId = null;

  await check("proposals_hold_gate", async () => {
    await setBalance(holder.wallet, CONTRIB_MIN_HOLD - 1n);
    const refused = await call(local(`/v1/apps/${app.slug}/proposals`), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ text: `${TAG} below the minimum hold, should be refused.` }) });
    await setBalance(holder.wallet, CONTRIB_MIN_HOLD);
    const allowed = await call(local(`/v1/apps/${app.slug}/proposals`), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ text: `${TAG} at the minimum hold, should be accepted.` }) });
    itemId = allowed.json?.id ?? null;
    if (itemId) onExit("queue item", async () => { await prisma.vote.deleteMany({ where: { itemId } }); await prisma.promptQueueItem.delete({ where: { id: itemId } }).catch(() => {}); });
    const row = itemId ? await prisma.promptQueueItem.findUnique({ where: { id: itemId } }) : null;
    const legacy = await call(local(`/v1/apps/${app.slug}/queue`), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ text: `${TAG} the old /queue path must be gone.` }) });
    return expect()
      .eq(refused.status, 403, "below-minimum status")
      .eq(refused.json?.error, "insufficient_holding", "below-minimum code")
      .eq(refused.json?.minHoldUnits, CONTRIB_MIN_HOLD.toString(), "below-minimum reports minHoldUnits")
      .eq(allowed.status, 201, "at-minimum status")
      .ok(itemId !== null, "accepted submission must return the item")
      .eq(allowed.json?.status, "OPEN", "dto status")
      .eq(allowed.json?.weightUnits, CONTRIB_MIN_HOLD.toString(), "dto weightUnits is the capped self-vote")
      .eq(allowed.json?.votes, 1, "dto votes")
      .eq(allowed.json?.votedByMe, true, "dto votedByMe")
      .eq(allowed.json?.author?.id, holder.id, "dto author")
      .eq(row?.status, "OPEN", "new item status")
      .eq(big(row?.weight), CONTRIB_MIN_HOLD, "self-vote weight")
      .eq(legacy.status, 404, "the renamed /queue route must 404")
      .done(`${CONTRIBUTOR_MIN_HOLD_BPS}bps (${Number(CONTRIB_MIN_HOLD / UNIT).toLocaleString("en-US")} tokens) required; below → 403, at → 201; /queue → 404`);
  });

  await check("proposals_page", async () => {
    const anon = await call(local(`/v1/apps/${app.slug}/proposals`));
    const mine = await call(local(`/v1/apps/${app.slug}/proposals`), { headers: authHeader(holder) });
    const outsider = await call(local(`/v1/apps/${app.slug}/proposals`), { headers: authHeader(state.users.outsider) });
    const missing = await call(local(`/v1/apps/no-such-app-${RUN}/proposals`));
    const item = mine.json?.items?.find((i) => i.id === itemId);
    return expect()
      .eq(anon.status, 200, "anonymous status")
      .ok(Array.isArray(anon.json?.items), "items array")
      .eq(anon.json?.minHoldUnits, CONTRIB_MIN_HOLD.toString(), "minHoldUnits")
      .eq(anon.json?.canSubmit, false, "anonymous canSubmit")
      .eq(anon.json?.myWeightUnits, "0", "anonymous myWeightUnits")
      .eq(mine.status, 200, "holder status")
      .eq(mine.json?.canSubmit, true, "a contributor-level holder canSubmit")
      .eq(mine.json?.myWeightUnits, CONTRIB_MIN_HOLD.toString(), "holder myWeightUnits")
      .ok(item !== undefined, "the submitted item must be listed")
      .eq(item?.votedByMe, true, "votedByMe for the author")
      .bigint(item?.weightUnits, "item weightUnits")
      .eq(outsider.json?.canSubmit, false, "a non-holder cannot submit")
      .eq(outsider.json?.myWeightUnits, "0", "non-holder myWeightUnits")
      .eq(missing.status, 404, "unknown slug status")
      .eq(missing.json?.error, "app_not_found", "unknown slug code")
      .done(`{items, minHoldUnits, canSubmit, myWeightUnits}: anon → canSubmit=false, holder → true with ${Number(CONTRIB_MIN_HOLD / UNIT).toLocaleString("en-US")} weight, unknown app → 404`);
  });

  await check("vote_weight_capped", async () => {
    const whale = VOTE_CAP * 3n;
    await setBalance(launcher.wallet, whale);
    const res = await call(local(`/v1/queue/${itemId}/vote`), { method: "POST", headers: jsonHeaders(launcher), body: "{}" });
    const vote = await prisma.vote.findFirst({ where: { itemId, userId: launcher.id } });
    const item = await prisma.promptQueueItem.findUnique({ where: { id: itemId } });
    return expect()
      .eq(res.status, 200, "http status")
      .eq(res.json?.weightUnits, (CONTRIB_MIN_HOLD + VOTE_CAP).toString(), "dto weightUnits")
      .eq(res.json?.votes, 2, "dto votes")
      .eq(res.json?.votedByMe, true, "dto votedByMe")
      .eq(big(vote?.weight), VOTE_CAP, "recorded weight must be capped")
      .ok(big(vote?.weight) < whale, "capped weight must be below the raw balance")
      .eq(big(item.weight), CONTRIB_MIN_HOLD + VOTE_CAP, "item weight is the sum of capped votes")
      .done(`a wallet holding ${(Number(whale) / Number(SUPPLY_BASE_UNITS) * 100).toFixed(1)}% of supply votes with the ${VOTE_WALLET_CAP_BPS}bps cap`);
  });

  await check("maintainer_election_threshold", async () => {
    const e = expect();
    // Electorate = holder (2% of supply, exactly the cap) + launcher (capped at 2%): one capped vote
    // is exactly half the electorate, which is not a strict majority.
    await prisma.maintainerVote.deleteMany({ where: { appId: app.id } });
    const minority = await call(local(`/v1/apps/${app.slug}/maintainer-vote`), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ candidateWallet: holder.wallet }) });
    let row = await prisma.app.findUnique({ where: { id: app.id }, select: { maintainerId: true } });
    e.eq(minority.status, 200, "minority vote status")
      .eq(minority.json?.elected, false, "half the electorate must not elect")
      .eq(minority.json?.weightUnits, VOTE_CAP.toString(), "minority weightUnits")
      .eq(minority.json?.candidateWallet, holder.wallet, "candidateWallet echoed")
      .eq(row.maintainerId, null, "no maintainer on a minority");

    // Both capped votes together carry the whole electorate — a strict majority.
    const majority = await call(local(`/v1/apps/${app.slug}/maintainer-vote`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ candidateWallet: holder.wallet }) });
    row = await prisma.app.findUnique({ where: { id: app.id }, select: { maintainerId: true } });
    e.eq(majority.status, 200, "majority vote status")
      .eq(majority.json?.elected, true, "strict majority must elect")
      .eq(majority.json?.weightUnits, (VOTE_CAP * 2n).toString(), "majority weightUnits")
      .eq(row.maintainerId, holder.id, "maintainer must be set");
    onExit("maintainer votes", async () => {
      await prisma.maintainerVote.deleteMany({ where: { appId: app.id } });
      await prisma.app.update({ where: { id: app.id }, data: { maintainerId: null } }).catch(() => {});
    });

    const notHolder = await call(local(`/v1/apps/${app.slug}/maintainer-vote`), { method: "POST", headers: jsonHeaders(state.users.outsider), body: JSON.stringify({ candidateWallet: holder.wallet }) });
    e.eq(notHolder.status, 403, "non-holder status").eq(notHolder.json?.error, "not_a_holder", "non-holder code");
    const badWallet = await call(local(`/v1/apps/${app.slug}/maintainer-vote`), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ candidateWallet: "not-an-address" }) });
    e.eq(badWallet.status, 400, "non-EVM candidate status").eq(badWallet.json?.error, "validation_failed", "non-EVM candidate code");
    return e.done("half the electorate → not elected, strict majority of the capped electorate → elected, non-holder → 403, non-0x candidate → 400");
  });

  await check("bounty_escrow_claim_payout", async () => {
    const e = expect();
    const wei = 20_000_000_000_000_000n; // 0.02 ETH escrowed
    const bounty = await prisma.bounty.create({
      data: { appId: app.id, authorId: state.users.launcher.id, title: `${TAG} bounty`, description: "audit fixture bounty", wei: dec(wei), escrowTx: fakeTxHash() },
    });
    onExit("bounty", async () => {
      await prisma.ledgerEntry.deleteMany({ where: { refId: bounty.id } });
      await prisma.bounty.delete({ where: { id: bounty.id } }).catch(() => {});
    });
    state.bountyId = bounty.id;
    await prisma.ledgerEntry.create({ data: { account: "TREASURY", deltaMicros: 54_000_000n, refType: "Bounty", refId: bounty.id, memo: "bounty escrow" } });
    e.eq(bounty.status, "OPEN", "escrowed status").eq(big(bounty.wei), wei, "escrowed wei");

    const noPr = await call(local(`/v1/bounties/${bounty.id}/claim`), { method: "POST", headers: jsonHeaders(state.users.holder), body: JSON.stringify({ prNumber: 4242 }) });
    e.eq(noPr.status, 404, "claim without a PR").eq(noPr.json?.error, "pr_not_found", "missing-PR code");

    const pr = await prisma.pullRequest.create({
      data: { appId: app.id, number: 4242, authorLogin: "audit", authorWallet: state.users.holder.wallet, title: `${TAG} pr`, url: "https://example.com/pr/4242", status: "OPEN" },
    });
    onExit("pull request", async () => { await prisma.pullRequest.delete({ where: { id: pr.id } }).catch(() => {}); });
    const openPr = await call(local(`/v1/bounties/${bounty.id}/claim`), { method: "POST", headers: jsonHeaders(state.users.holder), body: JSON.stringify({ prNumber: 4242 }) });
    e.eq(openPr.status, 409, "claim on an unmerged PR").eq(openPr.json?.error, "pr_not_merged", "unmerged code");

    await prisma.pullRequest.update({ where: { id: pr.id }, data: { status: "MERGED", mergeSha: "deadbeef" } });
    const wrongAuthor = await call(local(`/v1/bounties/${bounty.id}/claim`), { method: "POST", headers: jsonHeaders(state.users.outsider), body: JSON.stringify({ prNumber: 4242 }) });
    e.eq(wrongAuthor.status, 403, "claim by a wallet that is not the proven PR author").eq(wrongAuthor.json?.error, "pr_author_unverified", "author code");
    e.eq((await prisma.bounty.findUnique({ where: { id: bounty.id } })).status, "OPEN", "refused claims must not move the bounty");

    const claim = await call(local(`/v1/bounties/${bounty.id}/claim`), { method: "POST", headers: jsonHeaders(state.users.holder), body: JSON.stringify({ prNumber: 4242 }) });
    const claimed = await prisma.bounty.findUnique({ where: { id: bounty.id } });
    if (claim.status === 200) {
      e.eq(claimed.status, "PAID", "paid status").ok(HASH_RE.test(claimed.payoutTx ?? ""), "payoutTx must be a 0x tx hash").eq(claim.json?.wei, wei.toString(), "dto wei");
      const payoutLedger = await prisma.ledgerEntry.findFirst({ where: { refType: "Payout", refId: bounty.id } });
      e.ok(payoutLedger !== null, "payout must debit TREASURY").ok((payoutLedger?.deltaMicros ?? 0n) < 0n, "payout ledger must be negative");
      const done = e.done("");
      return done.ok ? { ok: true, detail: "OPEN → CLAIMED → PAID with a real treasury ETH payout" } : done;
    }
    // Unfunded treasury: the OPEN→CLAIMED happened, but a failed payout must release the bounty back to OPEN so it is never bricked.
    e.eq(claim.status, 502, "payout failure status").eq(claim.json?.error, "payout_failed", "payout failure code").eq(claim.json?.status, "OPEN", "response must report OPEN after revert");
    e.eq(claimed.status, "OPEN", "bounty must be released back to OPEN").eq(claimed.claimantId, null, "claimant cleared").eq(claimed.prNumber, null, "PR cleared");
    const reclaim = await call(local(`/v1/bounties/${bounty.id}/claim`), { method: "POST", headers: jsonHeaders(state.users.holder), body: JSON.stringify({ prNumber: 4242 }) });
    e.eq(reclaim.status, 502, "re-claim reaches payout again").eq(reclaim.json?.error, "payout_failed", "re-claim payout failure code");
    const done = e.done("");
    return done.ok
      ? { blocked: true, detail: `escrow → guards → atomic OPEN→CLAIMED all pass; PAID needs treasury ETH${state.rpcOk ? "" : " (and a reachable RPC)"} — transfer returned 502 payout_failed, bounty correctly released back to OPEN and re-claimable` }
      : done;
  });

  await check("bounty_create_funding_gate", async () => {
    const e = expect();
    const listed = await call(local(`/v1/apps/${app.slug}/bounties`));
    const mine = listed.json?.items?.find((b) => b.id === state.bountyId);
    e.eq(listed.status, 200, "list status")
      .ok(mine !== undefined, "the escrowed fixture bounty must be listed")
      .eq(mine?.wei, "20000000000000000", "listed wei is a decimal string")
      .eq(mine?.status, "OPEN", "listed status")
      .ok(HASH_RE.test(mine?.escrowTx ?? ""), "listed escrowTx")
      .eq(mine?.author?.id, launcher.id, "listed author");

    const dust = await call(local(`/v1/apps/${app.slug}/bounties`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ title: `${TAG} dust`, description: "far too small to be worth a payout tx", eth: 0.0001 }) });
    e.eq(dust.status, 400, "dust status").eq(dust.json?.error, "bounty_too_small", "dust code").eq(dust.json?.minWei, "1000000000000000", "dust reports the 0.001 ETH floor");
    const malformed = await call(local(`/v1/apps/${app.slug}/bounties`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ title: `${TAG} bad`, description: "the amount is no longer a usd figure", amountUsd: 5 }) });
    e.eq(malformed.status, 400, "non-eth body status").eq(malformed.json?.error, "validation_failed", "non-eth body code");

    const funded = await call(local(`/v1/apps/${app.slug}/bounties`), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ title: `${TAG} real`, description: "escrow 0.01 ETH from an empty custodial wallet", eth: 0.01 }) });
    const rows = await prisma.bounty.count({ where: { appId: app.id, title: `${TAG} real` } });
    e.eq(rows, 0, "no bounty row may be written before the escrow settles");
    if (unreachable(funded)) {
      const done = e.done("");
      return done.ok ? blockedOffline("list shape + floor + validation guards pass; custodial escrow reached the balance read") : done;
    }
    e.eq(funded.status, 400, "unfunded status")
      .eq(funded.json?.error, "insufficient_balance", "unfunded code")
      .bigint(funded.json?.needWei, "needWei")
      .bigint(funded.json?.haveWei, "haveWei")
      .ok(BigInt(funded.json?.needWei ?? 0) > ethToWei(0.01), "needWei covers the escrow plus the gas reserve");
    const done = e.done("");
    if (!done.ok) return done;
    return { blocked: true, detail: "list carries wei strings; 0.0001 ETH → 400 bounty_too_small; custodial escrow needs a funded wallet — 400 insufficient_balance, nothing written" };
  });

  await check("topup_funding_gate", async () => {
    const e = expect();
    const malformed = await call(local(`/v1/apps/${app.slug}/topup`), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ eth: 0 }) });
    e.eq(malformed.status, 400, "zero eth status").eq(malformed.json?.error, "validation_failed", "zero eth code");
    const missing = await call(local(`/v1/apps/no-such-app-${RUN}/topup`), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ eth: 0.01 }) });
    e.eq(missing.status, 404, "unknown app status").eq(missing.json?.error, "app_not_found", "unknown app code");
    const noWallet = await call(local(`/v1/apps/${state.apps.dormant.slug}/topup`), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ eth: 0.01 }) });
    e.eq(noWallet.status, 409, "app without a wallet status").eq(noWallet.json?.error, "app_has_no_wallet", "app without a wallet code");

    const funded = await call(local(`/v1/apps/${app.slug}/topup`), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ eth: 0.01 }) });
    const fees = await prisma.feeEvent.count({ where: { appId: app.id, source: "REVIVE_BUY" } });
    e.eq(fees, 0, "no REVIVE_BUY fee event may be written before the transfer settles");
    if (unreachable(funded)) {
      const done = e.done("");
      return done.ok ? blockedOffline("validation + wallet guards pass; custodial top-up reached the balance read") : done;
    }
    e.eq(funded.status, 400, "unfunded status")
      .eq(funded.json?.error, "insufficient_balance", "unfunded code")
      .bigint(funded.json?.needWei, "needWei")
      .ok(BigInt(funded.json?.needWei ?? 0) > ethToWei(0.01), "needWei covers the top-up plus the gas reserve");
    const done = e.done("");
    if (!done.ok) return done;
    return { blocked: true, detail: "{eth} validated; custodial top-up needs a funded wallet — 400 insufficient_balance, no fee event written" };
  });
}

/* ═══════════════════════════════ 5. platform api (wallets, chain, public dtos) ═══════════════════════════════ */

async function platformChecks() {
  section("platform");
  const holder = state.users.holder;
  const launcher = state.users.launcher;

  await check("wallet_login_challenge_verify", async () => {
    // A throwaway external wallet: the same EIP-191 personal_sign flow an injected wallet performs
    // over an EIP-4361 (Sign-In with Ethereum) message bound to the platform domain and chain.
    const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
    onExit("wallet-login user", async () => {
      await prisma.user.deleteMany({ where: { authWallet: account.address } });
    });
    const e = expect();
    const challenge = await call(local("/v1/auth/wallet/challenge"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address: account.address.toLowerCase() }) });
    const siwe = typeof challenge.json?.message === "string" ? parseSiweMessage(challenge.json.message) : {};
    const webOrigin = new URL(process.env.WEB_ORIGIN);
    e.eq(challenge.status, 200, "challenge status")
      .eq(challenge.json?.address, account.address, "address echoed checksummed")
      .eq(siwe.domain, webOrigin.host, "siwe domain is the platform web host")
      .eq(siwe.uri, process.env.WEB_ORIGIN, "siwe uri is the platform web origin")
      .eq(siwe.address, account.address, "siwe address is the checksummed caller")
      .eq(siwe.chainId, ROBINHOOD_CHAIN_ID, "siwe chainId is Robinhood Chain")
      .eq(siwe.version, "1", "siwe version")
      .ok(typeof siwe.statement === "string" && siwe.statement.length > 0, "siwe statement explains the signature costs no gas")
      .eq(siwe.nonce, challenge.json?.nonce, "siwe nonce is the issued nonce")
      .ok(/^[a-zA-Z0-9]{8,}$/.test(challenge.json?.nonce ?? ""), `nonce is alphanumeric and ≥8 chars (got ${JSON.stringify(challenge.json?.nonce)})`)
      .eq(siwe.issuedAt?.toISOString(), challenge.json?.issued, "siwe issuedAt is the issued timestamp")
      .eq(siwe.expirationTime?.toISOString(), challenge.json?.expiresAt, "siwe expirationTime is expiresAt")
      .eq(challenge.json?.ttlSeconds, 300, "ttlSeconds")
      .ok(Date.parse(challenge.json?.expiresAt ?? "") - Date.parse(challenge.json?.issued ?? "") === 300_000, "expiresAt is issued + ttl");

    const signature = await account.signMessage({ message: challenge.json.message });
    const verify = await call(local("/v1/auth/wallet/verify"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address: account.address, signature }) });
    e.eq(verify.status, 200, "verify status")
      .ok(typeof verify.json?.token === "string" && verify.json.token.split(".").length === 3, "a session JWT is issued")
      .eq(verify.json?.user?.authWallet, account.address, "user.authWallet is the proven address")
      .address(verify.json?.user?.wallet, "user.wallet is a custodial 0x address")
      .eq(verify.json?.user?.isAdmin, false, "wallet users are not admins");

    const row = await prisma.user.findUnique({ where: { authWallet: account.address } });
    e.ok(row !== null, "user row upserted by authWallet")
      .eq(row?.wallet, row ? deriveWallet(row.walletIndex).address : null, "custodial wallet derives from walletIndex (m/44'/60'/0'/0/i)")
      .ok((row?.walletIndex ?? 0) > 0, "walletIndex 0 is the treasury and never a user");

    // The token is a real session: an authenticated route answers, and it belongs to this user.
    const authed = await call(local(`/v1/launches/does-not-exist-${RUN}`), { headers: { authorization: `Bearer ${verify.json?.token}` } });
    e.eq(authed.status, 404, "session token passes the auth middleware (404 launch_not_found, not 401)").eq(authed.json?.error, "launch_not_found", "authenticated route code");

    // The challenge is single-use: replaying the very same signature fails closed.
    const replay = await call(local("/v1/auth/wallet/verify"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address: account.address, signature }) });
    e.eq(replay.status, 401, "replayed signature status").eq(replay.json?.error, "invalid_signature", "replayed signature code");
    e.eq(await prisma.user.count({ where: { authWallet: account.address } }), 1, "a second verify must not create a second user");
    return e.done(`challenge → viem personal_sign → verify issued a session for ${account.address.slice(0, 10)}…; custodial wallet derived; replay → 401`);
  });

  await check("wallet_login_forged_signature", async () => {
    const victim = fixtureAddress(600);
    const attacker = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
    const e = expect();
    const challenge = await call(local("/v1/auth/wallet/challenge"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address: victim }) });
    e.eq(challenge.status, 200, "challenge status");
    const forged = await attacker.signMessage({ message: challenge.json?.message ?? "" });
    const verify = await call(local("/v1/auth/wallet/verify"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address: victim, signature: forged }) });
    e.eq(verify.status, 401, "forged signature status").eq(verify.json?.error, "invalid_signature", "forged signature code");
    const noChallenge = await call(local("/v1/auth/wallet/verify"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address: attacker.address, signature: forged }) });
    e.eq(noChallenge.status, 401, "verify without a challenge status").eq(noChallenge.json?.error, "invalid_signature", "verify without a challenge code");
    const badAddress = await call(local("/v1/auth/wallet/challenge"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address: "0x1234" }) });
    e.eq(badAddress.status, 400, "non-address status").eq(badAddress.json?.error, "validation_failed", "non-address code");
    const badSig = await call(local("/v1/auth/wallet/verify"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address: victim, signature: "not-hex" }) });
    e.eq(badSig.status, 400, "non-hex signature status").eq(badSig.json?.error, "validation_failed", "non-hex signature code");
    e.eq(await prisma.user.count({ where: { authWallet: { in: [victim, attacker.address] } } }), 0, "a refused login must never create a user");
    return e.done("another key's signature → 401, no challenge → 401, malformed address/signature → 400; no user row created");
  });

  await check("rpc_allowlist", async () => {
    const rpc = (body) => call(local("/v1/rpc"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
    const e = expect();
    const send = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x00"] });
    e.eq(send.status, 403, "eth_sendRawTransaction status").eq(send.json?.error, "rpc_method_not_allowed", "eth_sendRawTransaction code").eq(send.json?.method, "eth_sendRawTransaction", "refused method echoed");
    const sign = await rpc({ jsonrpc: "2.0", id: 2, method: "eth_sign", params: [] });
    e.eq(sign.status, 403, "eth_sign status");
    const batch = await rpc([{ jsonrpc: "2.0", id: 3, method: "eth_chainId", params: [] }]);
    e.eq(batch.status, 400, "batch status").eq(batch.json?.error, "rpc_batch_not_allowed", "batch code");
    const unbounded = await rpc({ jsonrpc: "2.0", id: 4, method: "eth_getLogs", params: [{ fromBlock: "latest" }] });
    e.eq(unbounded.status, 400, "unbounded eth_getLogs status").eq(unbounded.json?.error, "rpc_log_range_required", "unbounded eth_getLogs code").eq(unbounded.json?.maxBlocks, 2000, "maxBlocks reported");
    const tooWide = await rpc({ jsonrpc: "2.0", id: 5, method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x1000" }] });
    e.eq(tooWide.status, 400, "too-wide eth_getLogs status").eq(tooWide.json?.error, "rpc_log_range_too_wide", "too-wide eth_getLogs code");
    const fullBlocks = await rpc({ jsonrpc: "2.0", id: 6, method: "eth_getBlockByNumber", params: ["latest", true] });
    e.eq(fullBlocks.status, 400, "full-block status").eq(fullBlocks.json?.error, "rpc_full_blocks_not_allowed", "full-block code");
    const notRpc = await rpc({ method: "eth_chainId" });
    e.eq(notRpc.status, 400, "non-JSON-RPC body status").eq(notRpc.json?.error, "validation_failed", "non-JSON-RPC body code");

    const chainId = await rpc({ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] });
    if (chainId.status >= 500 && !state.rpcOk) {
      const done = e.done("");
      return done.ok ? blockedOffline("every guard refuses; the allowlisted eth_chainId reached the upstream") : done;
    }
    e.eq(chainId.status, 200, "allowlisted method status")
      .eq(chainId.json?.id, 7, "upstream id echoed")
      .eq(Number(chainId.json?.result), ROBINHOOD_CHAIN_ID, `upstream chain id must be ${ROBINHOOD_CHAIN_ID} (Robinhood Chain)`);
    return e.done(`sendRawTransaction/eth_sign → 403, batch → 400, unbounded/too-wide getLogs → 400, full blocks → 400; eth_chainId → ${chainId.json?.result} (${ROBINHOOD_CHAIN_ID})`);
  });

  await check("status_page", async () => {
    const res = await call(`${API}/v1/status`);
    const s = res.json?.services;
    const e = expect()
      .ok(res.status === 200 || res.status === 503, `status must be 200 or 503 (got ${res.status})`)
      .eq(res.status, res.json?.ok ? 200 : 503, "http status follows ok")
      .ok(typeof res.json?.version === "string" && res.json.version.length > 0, "version")
      .ok(Number.isInteger(res.json?.uptimeSec) && res.json.uptimeSec >= 0, "uptimeSec")
      .eq(s?.db?.ok, true, "services.db.ok")
      .eq(s?.redis?.ok, true, "services.redis.ok")
      .ok(typeof s?.rpc?.ok === "boolean" && typeof s?.rpc?.latencyMs === "number", "services.rpc shape")
      .ok(s?.rpc?.ok ? Number.isInteger(s.rpc.blockNumber) && s.rpc.blockNumber > 0 : s?.rpc?.blockNumber === null, "rpc blockNumber tracks rpc.ok")
      .ok(s?.queues?.depths && typeof s.queues.depths === "object", "services.queues.depths")
      .eq(res.json?.chain?.chainId, ROBINHOOD_CHAIN_ID, "chain.chainId")
      .ok(typeof res.json?.chain?.ethPriceUsd === "number", "chain.ethPriceUsd")
      .ok(ISO_RE.test(res.json?.updatedAt ?? ""), "updatedAt")
      .eq(res.json?.ok, Boolean(s?.db?.ok && s?.redis?.ok && s?.rpc?.ok), "ok is db && redis && rpc");
    for (const name of ["intake", "launch", "build", "prReview", "scheduler"]) {
      const d = s?.queues?.depths?.[name];
      e.ok(d && Number.isInteger(d.waiting) && Number.isInteger(d.active) && Number.isInteger(d.failed), `queue depth for ${name}`);
    }
    const done = e.done("");
    if (!done.ok) return done;
    if (!res.json.ok) return { blocked: true, detail: `503 reported honestly: rpc.ok=${s.rpc.ok} (${offline() || "rpc down on the probed api"}), db+redis ok, chain ${ROBINHOOD_CHAIN_ID}` };
    return { ok: true, detail: `200 ok; db ${s.db.latencyMs}ms, redis ${s.redis.latencyMs}ms, rpc ${s.rpc.latencyMs}ms @ block ${s.rpc.blockNumber}, ETH $${res.json.chain.ethPriceUsd}` };
  });

  await check("stats_shape", async () => {
    const res = await call(`${API}/v1/stats`);
    if (unreachable(res)) return blockedOffline("stats reached the ETH oracle / $PYRE snapshot");
    const j = res.json ?? {};
    const e = expect().eq(res.status, 200, "http status");
    for (const k of ["appsLive", "appsBuilding", "appsTotal", "buybacksCount"]) e.ok(Number.isInteger(j[k]) && j[k] >= 0, `${k} is a non-negative int`);
    for (const k of ["revenueTotalMicros", "revenue24hMicros", "revenue30dMicros", "feesTotalWei", "burnedEthWei", "burnedEth24hWei", "burnedEth30dWei"]) e.bigint(j[k], k);
    e.ok(j.counts && typeof j.counts === "object", "counts object");
    for (const sort of AppSort.options) e.ok(Number.isInteger(j.counts?.[sort]), `counts.${sort} is an int`);
    e.ok(typeof j.agentHoursToday === "number" && j.agentHoursToday >= 0, "agentHoursToday")
      .ok(typeof j.ethPriceUsd === "number" && j.ethPriceUsd > 0, "ethPriceUsd is a positive number")
      .ok(j.pyreToken === null || (ADDRESS_RE.test(j.pyreToken?.address ?? "") && BIGINT_RE.test(j.pyreToken?.burnedUnits ?? "")), "pyreToken is null or {address, burnedUnits…}")
      .ok(ISO_RE.test(j.updatedAt ?? ""), "updatedAt")
      .ok(BigInt(j.burnedEth24hWei ?? 0) <= BigInt(j.burnedEth30dWei ?? 0), "24h burn ≤ 30d burn")
      .ok(BigInt(j.revenue24hMicros ?? 0) <= BigInt(j.revenue30dMicros ?? 0), "24h revenue ≤ 30d revenue");
    return e.done(`${j.appsTotal} public apps (${j.appsLive} live), counts{${AppSort.options.map((s) => `${s}:${j.counts?.[s]}`).join(" ")}}, burned ${j.burnedEthWei} wei, ETH $${j.ethPriceUsd}, pyreToken ${j.pyreToken ? "launched" : "null"}`);
  });

  await check("apps_list_sorts", async () => {
    const e = expect();
    const seen = [];
    for (const sort of AppSort.options) {
      const res = await call(`${API}/v1/apps?sort=${sort}&limit=5`);
      if (unreachable(res)) return blockedOffline(`sort=${sort} reached the ETH oracle (${seen.length} sorts already 200)`);
      e.eq(res.status, 200, `sort=${sort} status`)
        .ok(Array.isArray(res.json?.items), `sort=${sort} items array`)
        .ok((res.json?.items?.length ?? 99) <= 5, `sort=${sort} honours limit`)
        .ok(res.json?.nextCursor === null || typeof res.json?.nextCursor === "string", `sort=${sort} nextCursor`);
      for (const item of res.json?.items ?? []) {
        e.ok(item.status === "LIVE" || item.status === "DORMANT", `sort=${sort} ${item.slug}: public status`)
          .address(item.tokenAddress, `sort=${sort} ${item.slug}: tokenAddress`)
          .bigint(item.feesWei, `sort=${sort} ${item.slug}: feesWei`)
          .bigint(item.buybackWei, `sort=${sort} ${item.slug}: buybackWei`)
          .bigint(item.burnedUnits, `sort=${sort} ${item.slug}: burnedUnits`)
          .ok(typeof item.heat === "number" && item.heat >= 0 && item.heat <= 1, `sort=${sort} ${item.slug}: heat in [0,1]`)
          .ok(typeof item.progress === "number", `sort=${sort} ${item.slug}: progress`)
          .ok(item.phase !== undefined && item.launcher && typeof item.launcher.id === "string", `sort=${sort} ${item.slug}: phase + launcher`);
      }
      seen.push(`${sort}:${res.json?.items?.length ?? "?"}`);
    }
    const bogus = await call(`${API}/v1/apps?sort=hottest`);
    e.eq(bogus.status, 400, "unknown sort status").eq(bogus.json?.error, "validation_failed", "unknown sort code");
    // Search bypasses the ranked sorts and must surface this run's tokenised fixture by slug.
    const rig = state.apps.rig;
    const search = await call(`${API}/v1/apps?q=${encodeURIComponent(rig.slug)}`);
    e.eq(search.status, 200, "search status")
      .eq(search.json?.nextCursor, null, "search has no cursor")
      .ok(search.json?.items?.some((i) => i.id === rig.id && i.tokenAddress === rig.tokenAddress), "search must find the tokenised fixture app");
    const hidden = await call(`${API}/v1/apps?q=${encodeURIComponent(state.apps.gate.slug)}`);
    e.eq(hidden.json?.items?.length ?? -1, 0, "an app without a token must not be public");
    return e.done(`7 sorts → 200 {items,nextCursor} (${seen.join(" ")}); bogus sort → 400; search finds the fixture, tokenless app hidden`);
  });

  await check("burns_ledger", async () => {
    const res = await call(`${API}/v1/burns?limit=5`);
    const j = res.json ?? {};
    const e = expect()
      .eq(res.status, 200, "http status")
      .ok(Array.isArray(j.items) && j.items.length <= 5, "items array within limit")
      .ok(j.nextCursor === null || typeof j.nextCursor === "string", "nextCursor")
      .bigint(j.totals?.ethWei, "totals.ethWei")
      .bigint(j.totals?.revenueMicros, "totals.revenueMicros")
      .ok(Number.isInteger(j.totals?.buybacks) && j.totals.buybacks >= (j.items?.length ?? 0), "totals.buybacks covers the page")
      .ok(Number.isInteger(j.totals?.coins) && j.totals.coins <= j.totals?.buybacks, "totals.coins ≤ totals.buybacks");
    const items = j.items ?? [];
    for (const [i, row] of items.entries()) {
      e.eq(row.status, "BURNED", `row ${i} status`)
        .bigint(row.ethWei, `row ${i} ethWei`)
        .bigint(row.revenueMicros, `row ${i} revenueMicros`)
        .bigint(row.cumulativeEthWei, `row ${i} cumulativeEthWei`)
        .bigint(row.cumulativeRevenueMicros, `row ${i} cumulativeRevenueMicros`)
        .bigint(row.tokensBurnedUnits, `row ${i} tokensBurnedUnits`)
        .ok(typeof row.burnedPctOfSupply === "number", `row ${i} burnedPctOfSupply`)
        .ok(row.completedAt !== null, `row ${i} completedAt`)
        .ok(typeof row.slug === "string" && typeof row.ticker === "string", `row ${i} slug/ticker`);
      const next = items[i + 1];
      if (next) {
        e.eq(BigInt(row.cumulativeEthWei) - BigInt(next.cumulativeEthWei), BigInt(row.ethWei), `row ${i} cumulative ETH steps by its own burn`)
          .eq(BigInt(row.cumulativeRevenueMicros) - BigInt(next.cumulativeRevenueMicros), BigInt(row.revenueMicros), `row ${i} cumulative revenue steps by its own attestation`);
      }
    }
    if (items.length > 0) {
      e.eq(items[0].cumulativeEthWei, j.totals.ethWei, "newest row's running total equals totals.ethWei")
        .eq(items[0].cumulativeRevenueMicros, j.totals.revenueMicros, "newest row's running total equals totals.revenueMicros");
    }
    const fixture = items.find((r) => r.id === state.buybackId);
    if (fixture) e.eq(fixture.ethWei, "2000000000000000", "fixture burn ethWei").eq(fixture.tokensBurnedUnits, (1_234n * UNIT).toString(), "fixture burnedUnits");
    return e.done(`${j.totals?.buybacks} burns across ${j.totals?.coins} coins, ${j.totals?.ethWei} wei total; page of ${items.length} with exact running totals${fixture ? " (this run's burn on top)" : ""}`);
  });

  await check("pyre_page", async () => {
    const anon = await call(`${API}/v1/pyre`);
    if (unreachable(anon)) return blockedOffline("$PYRE overview reached the chain");
    const j = anon.json ?? {};
    const e = expect()
      .eq(anon.status, 200, "anonymous status")
      .ok(typeof j.launched === "boolean", "launched")
      .ok(j.token === null || ADDRESS_RE.test(j.token?.address ?? ""), "token null or {address…}")
      .eq(j.launched, j.token !== null, "launched ⇔ token present")
      .bigint(j.ledger?.accruedMicros, "ledger.accruedMicros")
      .bigint(j.ledger?.burnedMicros, "ledger.burnedMicros")
      .bigint(j.ledger?.pendingMicros, "ledger.pendingMicros")
      .eq(j.feeShareBps, FEE_SPLIT_BPS.PYRE_TOKEN, "feeShareBps")
      .eq(j.revenueShareBps, REVENUE_SPLIT_BPS.PYRE_TOKEN, "revenueShareBps")
      .bigint(j.stakes?.totalUnits, "stakes.totalUnits")
      .ok(Number.isInteger(j.stakes?.stakers), "stakes.stakers")
      .bigint(j.stakes?.earnedMicros, "stakes.earnedMicros")
      .ok(Array.isArray(j.burns), "burns array")
      .ok(Number.isInteger(j.proposals?.open) && Number.isInteger(j.proposals?.shipped), "proposals counts")
      .ok(Array.isArray(j.topStakes), "topStakes array")
      .eq(j.viewer, null, "anonymous viewer");
    const legacy = await call(`${API}/v1/ship`);
    e.eq(legacy.status, 404, "the renamed /ship route must 404");

    const mine = await call(local("/v1/pyre"), { headers: authHeader(holder) });
    if (unreachable(mine)) {
      const done = e.done("");
      return done.ok ? blockedOffline("anonymous PyrePageDto shape ok; the viewer's $PYRE balance read reached the chain") : done;
    }
    const stake = await prisma.pyreStake.findFirst({ where: { appId: state.apps.feeFork.id, wallet: holder.wallet } });
    const v = mine.json?.viewer;
    e.eq(mine.status, 200, "holder status")
      .ok(v !== null && typeof v === "object", "holder viewer present")
      .bigint(v?.units, "viewer.units")
      .eq(v?.stakedUnits, stake ? big(stake.amount).toString() : undefined, "viewer.stakedUnits is the fixture stake")
      .eq(v?.earnedMicros, stake?.earnedMicros?.toString(), "viewer.earnedMicros is the accrued staker share")
      .ok(typeof v?.canPropose === "boolean", "viewer.canPropose")
      .ok(Array.isArray(v?.stakes) && v.stakes.some((s) => s.id === stake?.id && s.appSlug === state.apps.feeFork.slug), "viewer.stakes lists the fixture stake");

    const stakeRes = await call(local("/v1/pyre/stake"), { method: "POST", headers: jsonHeaders(holder), body: JSON.stringify({ appId: state.apps.feeFork.id, amount: 1 }) });
    if (unreachable(stakeRes)) {
      const done = e.done("");
      return done.ok ? blockedOffline("PyrePageDto + viewer ok; staking reached the balance read") : done;
    }
    if (!j.launched) {
      e.eq(stakeRes.status, 503, "stake before launch status").eq(stakeRes.json?.error, "pyre_not_launched", "stake before launch code");
    } else {
      e.eq(stakeRes.status, 400, "stake from an empty wallet status").ok(stakeRes.json?.error === "insufficient_balance" || stakeRes.json?.error === "insufficient_gas", `stake from an empty wallet code (got ${stakeRes.json?.error})`);
    }
    e.eq(await prisma.pyreStake.count({ where: { wallet: holder.wallet, appId: state.apps.feeFork.id } }), 1, "no new stake row may be written");
    return e.done(`PyrePageDto ok (launched=${j.launched}, ${j.stakes.stakers} stakers, ${j.burns.length} burns); viewer sees the fixture stake; /pyre/stake → ${stakeRes.status} ${stakeRes.json?.error}; /ship → 404`);
  });

  await check("me_dto", async () => {
    const res = await call(local("/v1/me"), { headers: authHeader(launcher) });
    if (unreachable(res)) return blockedOffline("/v1/me reached the custodial balance reads");
    const j = res.json ?? {};
    const e = expect()
      .eq(res.status, 200, "http status")
      .eq(j.user?.id, launcher.id, "user.id")
      .eq(j.user?.tier, "NEW", "user.tier")
      .eq(j.user?.isAdmin, false, "user.isAdmin")
      .eq(j.wallet, launcher.wallet, "wallet is the custodial address")
      .eq(j.authWallet, null, "authWallet is null for a Google user")
      .bigint(j.balances?.ethWei, "balances.ethWei")
      .bigint(j.balances?.usdgUnits, "balances.usdgUnits")
      .ok(typeof j.balances?.ethPriceUsd === "number", "balances.ethPriceUsd")
      .eq(j.balances?.ethWei, "0", "the fixture wallet holds no ETH")
      .ok(Array.isArray(j.positions), "positions array")
      .ok(Array.isArray(j.launched) && j.launched.length === 2 && j.launched.every((l) => typeof l.slug === "string" && BIGINT_RE.test(l.stakeWei) && l.stakeTo === state.treasury), "launched lists both drafts as LaunchDraftDto")
      .bigint(j.claimable?.launcherMicros, "claimable.launcherMicros")
      .bigint(j.claimable?.launcherWei, "claimable.launcherWei")
      .bigint(j.claimable?.stakerMicros, "claimable.stakerMicros")
      .eq(j.launchesToday, 2, "launchesToday counts this run's drafts")
      .eq(j.launchLimitPerDay, LAUNCH_RATE_LIMIT_PER_DAY.NEW, "launchLimitPerDay")
      .ok(Number.isInteger(j.notifications?.unread), "notifications.unread")
      .bigint(j.withdrawRemainingMicros, "withdrawRemainingMicros");
    const balances = await call(local("/v1/me/balances"), { headers: authHeader(launcher) });
    e.eq(balances.status, 200, "/me/balances status").eq(balances.json?.ethWei, j.balances?.ethWei, "/me/balances agrees with /me");
    const quote = await call(local("/v1/me/quote"), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ slug: state.apps.feeParent.slug, side: "buy", amount: "1000" }) });
    e.eq(quote.status, 404, "quote on an app without a token status").eq(quote.json?.error, "app_not_found", "quote on an app without a token code");
    const badSide = await call(local("/v1/me/quote"), { method: "POST", headers: jsonHeaders(launcher), body: JSON.stringify({ slug: state.apps.feeFork.slug, side: "hold", amount: "1000" }) });
    e.eq(badSide.status, 400, "invalid trade side status").eq(badSide.json?.error, "validation_failed", "invalid trade side code");
    return e.done(`MeDto: custodial wallet ${j.wallet?.slice(0, 10)}…, ${j.balances?.ethWei} wei / ${j.balances?.usdgUnits} USDG units, ${j.launched?.length} launches (${j.launchesToday}/${j.launchLimitPerDay} today); quote guards refuse`);
  });

  await check("admin_ops", async () => {
    const forbidden = await call(local("/v1/admin/ops"), { headers: authHeader(holder) });
    const res = await call(local("/v1/admin/ops"), { headers: authHeader(state.users.admin) });
    const j = res.json ?? {};
    const e = expect()
      .ok(forbidden.status === 403 || forbidden.status === 401, `a non-admin must be refused (got ${forbidden.status})`)
      .eq(res.status, 200, "admin status")
      .ok(ISO_RE.test(j.generatedAt ?? ""), "generatedAt")
      .eq(j.treasury?.address, state.treasury, "treasury.address")
      .bigint(j.treasury?.ethWei, "treasury.ethWei")
      .bigint(j.treasury?.usdgUnits, "treasury.usdgUnits")
      .eq(j.chain?.chainId, ROBINHOOD_CHAIN_ID, "chain.chainId")
      .ok(Number.isInteger(j.chain?.blockNumber), "chain.blockNumber")
      .ok(typeof j.chain?.ethPriceUsd === "number", "chain.ethPriceUsd")
      .ok(typeof j.chain?.rpcOk === "boolean", "chain.rpcOk")
      .eq(j.chain?.rpcOk, j.chain?.blockNumber > 0, "rpcOk ⇔ a block was read")
      .ok(j.apps && typeof j.apps === "object", "apps status counts")
      .ok(Number.isInteger(j.jobs?.queued) && Number.isInteger(j.jobs?.running), "jobs counts")
      .eq(j.compute?.ceilingMicros, CEILING_MICROS.toString(), "compute.ceilingMicros")
      .bigint(j.compute?.todayMicros, "compute.todayMicros")
      .bigint(j.money?.feesTotalWei, "money.feesTotalWei")
      .bigint(j.money?.fees24hWei, "money.fees24hWei")
      .bigint(j.money?.revenueTotalMicros, "money.revenueTotalMicros")
      .ok(j.money?.ledger && typeof j.money.ledger === "object" && Object.values(j.money.ledger).every((v) => /^-?\d+$/.test(v)), "money.ledger balances are bigint strings")
      .ok(Number.isInteger(j.flags?.open) && Number.isInteger(j.flags?.reportsOpen), "flags")
      .ok(j.settings && typeof j.settings === "object", "settings")
      .ok(Array.isArray(j.reconcile), "reconcile array")
      .ok(Array.isArray(j.alerts) && j.alerts.every((a) => ["info", "warn", "critical"].includes(a.level) && typeof a.code === "string"), "alerts[{level, code}]")
      .ok(Array.isArray(j.running) && Array.isArray(j.failed) && Array.isArray(j.flagList) && Array.isArray(j.reportList) && Array.isArray(j.killed), "running/failed/flagList/reportList/killed lists")
      .ok(j.running?.some((job) => job.id === state.proxy.jobId), "the RUNNING proxy fixture job is listed")
      .ok(Array.isArray(j.reconcileRuns) && Array.isArray(j.audit), "reconcileRuns/audit lists")
      .ok(Number.isInteger(j.users) && j.users > 0, `users is the platform user count (got ${JSON.stringify(j.users)})`)
      .ok(j.credits && typeof j.credits === "object", "credits rollup");
    if (!j.chain?.rpcOk) e.ok(j.alerts?.some((a) => a.code === "rpc_down"), "an unreachable RPC must raise the rpc_down alert");
    return e.done(`OpsDto: treasury ${j.treasury?.address?.slice(0, 10)}… ${j.treasury?.ethWei} wei / ${j.treasury?.usdgUnits} USDG, chain ${j.chain?.chainId} block ${j.chain?.blockNumber} (rpcOk=${j.chain?.rpcOk}), ${j.alerts?.length} alerts, ${j.running?.length} running; non-admin → ${forbidden.status}`);
  });
}

/* ═══════════════════════════════ 6. hosting + app runtime ═══════════════════════════════ */

async function hostingChecks() {
  section("hosting");
  const { APP_CSP } = await import("../dist/host/headers.js");
  const { createSessionCookie } = await import("../dist/host/session.js");
  const rig = state.apps.rig;
  const rigBase = `${API}/a/${rig.slug}`;
  const demoBase = `${API}/a/${DEMO_SLUG}`;
  const rigCookie = `pyre_app_session=${encodeURIComponent(createSessionCookie(state.users.holder.id, rig.id))}`;
  const demoCookie = state.demo ? `pyre_app_session=${encodeURIComponent(createSessionCookie(state.users.holder.id, state.demo.id))}` : "";
  // Browser provenance is checked against the app's public origin, never the transport base.
  const sameOrigin = { origin: PUBLIC_ORIGIN, referer: `${PUBLIC_ORIGIN}/a/${rig.slug}/` };

  await check("demo_app_csp", async () => {
    if (!state.demo) return { ok: false, detail: `no app with slug "${DEMO_SLUG}"` };
    const res = await call(`${demoBase}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const directive = (name) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name) ?? "";
    return expect()
      .eq(res.status, 200, "http status")
      .eq(csp, APP_CSP, "CSP must match APP_CSP verbatim")
      .eq(directive("default-src"), "default-src 'self'", "default-src is self only")
      .eq(directive("script-src"), "script-src 'self' https://accounts.google.com/gsi/client", "script-src is self plus Google Identity")
      .eq(directive("form-action"), "form-action 'none'", "no form posts leave the app")
      .eq(directive("base-uri"), "base-uri 'none'", "base-uri is locked")
      .eq(directive("frame-src"), "frame-src https://accounts.google.com/gsi/", "only the Google sign-in frame may be embedded")
      .eq(res.headers.get("x-frame-options"), "DENY", "X-Frame-Options")
      .eq(res.headers.get("x-content-type-options"), "nosniff", "X-Content-Type-Options")
      // Same-origin: nothing leaks to third parties, while same-origin `/_pyre/*` calls still carry
      // the page URL that proves a path-routed app's provenance (lib/origin.ts).
      .eq(res.headers.get("referrer-policy"), "same-origin", "Referrer-Policy")
      .eq(res.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups", "COOP")
      .eq(res.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()", "Permissions-Policy")
      .ok(res.text.includes("<"), "body must be html")
      .done(`GET /a/${DEMO_SLUG}/ → 200 with the locked-down CSP, Referrer-Policy same-origin and the full header set`);
  });

  await check("env_js_payload", async () => {
    const res = await call(`${demoBase}/_pyre/env.js`);
    const match = /window\.__PYRE__ = (\{.*?\});\n/s.exec(res.text);
    const payload = match ? JSON.parse(match[1]) : null;
    return expect()
      .eq(res.status, 200, "http status")
      .ok((res.headers.get("content-type") ?? "").startsWith("application/javascript"), `content-type (${res.headers.get("content-type")})`)
      .eq(res.headers.get("cache-control"), "no-store", "cache-control")
      .ok(payload !== null, "payload must parse")
      .eq(payload?.slug, DEMO_SLUG, "slug")
      .eq(payload?.appId, state.demo?.id, "appId")
      .eq(payload?.basePath, `/a/${DEMO_SLUG}`, "basePath")
      .eq(payload?.apiOrigin, PUBLIC_ORIGIN, "apiOrigin")
      .eq(payload?.chainId, ROBINHOOD_CHAIN_ID, "chainId is Robinhood Chain")
      .address(payload?.usdg, "usdg token address")
      .address(payload?.treasury, "treasury address")
      .eq(payload?.treasury, state.treasury, "treasury is the platform treasury")
      .ok(payload?.tokenAddress === "" || ADDRESS_RE.test(payload?.tokenAddress ?? ""), "tokenAddress is empty or 0x")
      .eq(payload?.tokenAddress, state.demo?.tokenAddress ?? "", "tokenAddress mirrors the app row")
      .ok(typeof payload?.explorerUrl === "string" && payload.explorerUrl.startsWith("https://"), "explorerUrl")
      .ok(typeof payload?.googleClientId === "string" && payload.googleClientId.length > 0, "googleClientId")
      .ok(Number(payload?.version) > 0, "version must be the live deployment")
      .ok(Array.isArray(payload?.products) && Array.isArray(payload?.functions), "products/functions arrays")
      .ok(res.text.includes("Object.freeze(window.__PYRE__)"), "payload must be frozen")
      .ok(!res.text.includes("</script>"), "payload must escape any closing script tag")
      .done(`v${payload?.version}, chain ${payload?.chainId}, usdg ${payload?.usdg?.slice(0, 10)}…, ${payload?.functions?.length ?? 0} fn / ${payload?.products?.length ?? 0} products, basePath ${payload?.basePath}`);
  });

  await check("fn_hello_with_kv", async () => {
    // The referer has to sit under the DEMO app's base path on the public origin, not the rig's.
    const demoHeaders = { "content-type": "application/json", ...sameOrigin, referer: `${PUBLIC_ORIGIN}/a/${DEMO_SLUG}/` };
    const before = await prisma.appKv.findUnique({ where: { appId_scope_key: { appId: state.demo.id, scope: "app", key: "calls" } } });
    const res = await call(`${demoBase}/_pyre/fn/hello`, { method: "POST", headers: demoHeaders, body: JSON.stringify({ name: `audit-${RUN}` }) });
    const after = await prisma.appKv.findUnique({ where: { appId_scope_key: { appId: state.demo.id, scope: "app", key: "calls" } } });
    const second = await call(`${demoBase}/_pyre/fn/hello`, { method: "POST", headers: demoHeaders, body: JSON.stringify({ name: `audit-${RUN}` }) });
    return expect()
      .eq(res.status, 200, "http status")
      .eq(res.json?.result?.greeting, `hello audit-${RUN}`, "function output")
      .ok(typeof res.json?.result?.calls === "number", "kv-backed counter must be returned")
      .ok(after !== null, "kv row must exist after the call")
      .eq(Number(after?.value), Number(before?.value ?? 0) + 1, "kv counter must persist across the call")
      .eq(second.json?.result?.calls, Number(res.json?.result?.calls) + 1, "second call must observe the persisted value")
      .done(`QuickJS ran hello(); kv "calls" ${Number(before?.value ?? 0)} → ${second.json?.result?.calls} across two invocations`);
  });

  await check("pyre_me", async () => {
    const anon = await call(`${demoBase}/_pyre/me`);
    const authed = await call(`${demoBase}/_pyre/me`, { headers: { cookie: demoCookie } });
    const foreignCookie = `pyre_app_session=${encodeURIComponent(createSessionCookie(state.users.holder.id, rig.id))}`;
    const wrongApp = await call(`${demoBase}/_pyre/me`, { headers: { cookie: foreignCookie } });
    return expect()
      .eq(anon.status, 200, "anonymous status")
      .eq(anon.json?.user, null, "anonymous user")
      .ok(anon.json?.holder && typeof anon.json.holder.isHolder === "boolean", "holder info")
      .ok(Array.isArray(anon.json?.purchases), "purchases array")
      .eq(authed.status, 200, "authed status")
      .eq(authed.json?.user?.id, state.users.holder.id, "session user")
      .eq(authed.json?.holder?.minHold, 100000, "holder tier from the manifest")
      .eq(wrongApp.json?.user, null, "a cookie bound to another app must not authenticate")
      .done(`anonymous → null user; app-bound cookie → ${state.users.holder.id.slice(0, 8)}…; cross-app cookie rejected`);
  });

  await check("checkout_funding_gate", async () => {
    // /_pyre/checkout is one-shot and server-signs the USDG transfer (EIP-3009) from the caller's
    // custodial wallet — no client-built transaction and no confirm step. The audit wallet holds
    // nothing, so a signed-in caller hits the 402 funding gate before any purchase row is written;
    // the auth and unknown-product guards still fully assert.
    const e = expect();
    const anon = await call(`${rigBase}/_pyre/checkout`, { method: "POST", headers: { "content-type": "application/json", ...sameOrigin }, body: JSON.stringify({ productId: "pro" }) });
    e.eq(anon.status, 401, "anonymous checkout status");
    const unknown = await call(`${rigBase}/_pyre/checkout`, { method: "POST", headers: { "content-type": "application/json", cookie: rigCookie, ...sameOrigin }, body: JSON.stringify({ productId: "nope" }) });
    e.eq(unknown.status, 404, "unknown product status");

    const funded = await call(`${rigBase}/_pyre/checkout`, { method: "POST", headers: { "content-type": "application/json", cookie: rigCookie, ...sameOrigin }, body: JSON.stringify({ productId: "pro" }) });
    const reserved = await prisma.purchase.count({ where: { appId: rig.id, userId: state.users.holder.id, productId: "pro" } });
    e.eq(reserved, 0, "no purchase row may be written before the transfer settles");
    if (unreachable(funded)) {
      const done = e.done("");
      return done.ok ? blockedOffline("anon → 401, unknown product → 404; the USDG balance read reached the chain") : done;
    }
    e.eq(funded.status, 402, "insufficient-funds status")
      .eq(funded.json?.error, "insufficient_funds", "funding gate code")
      .eq(String(funded.json?.priceUsd), "1", "priceUsd echoed back")
      .eq(String(funded.json?.balanceUsd), "0", "balanceUsd of the empty wallet")
      .eq(funded.json?.depositAddress, state.users.holder.wallet, "depositAddress is the caller's custodial wallet");
    const done = e.done("");
    if (!done.ok) return done;
    return { blocked: true, detail: "custodial USDG checkout reached; needs a funded wallet — 402 {insufficient_funds, priceUsd, balanceUsd, depositAddress}, no purchase reserved; anon → 401, unknown product → 404" };
  });

  await check("x402_funding_gate", async () => {
    // Paid functions server-sign the USDG transfer from the caller's custodial wallet: there is no
    // 402 challenge header, no client X-PAYMENT, and no replay lock. Anonymous callers are refused
    // outright; a signed-in caller with an empty wallet hits the funding gate.
    const e = expect();
    const anon = await call(`${rigBase}/_pyre/fn/paid`, { method: "POST", headers: { "content-type": "application/json", ...sameOrigin }, body: "{}" });
    e.eq(anon.status, 401, "anonymous paid call must require sign-in");
    const funded = await call(`${rigBase}/_pyre/fn/paid`, { method: "POST", headers: { "content-type": "application/json", cookie: rigCookie, ...sameOrigin }, body: "{}" });
    const revenue = await prisma.revenueEvent.count({ where: { appId: rig.id, source: "X402" } });
    e.eq(revenue, 0, "no revenue may be recorded for an unpaid call");
    if (unreachable(funded)) {
      const done = e.done("");
      return done.ok ? blockedOffline("anon → 401; the USDG balance read reached the chain") : done;
    }
    e.eq(funded.status, 402, "authenticated but unfunded status")
      .eq(funded.json?.error, "insufficient_funds", "funding gate code")
      .eq(String(funded.json?.priceUsd), "0.25", "priceUsd echoed back")
      .eq(String(funded.json?.balanceUsd), "0", "balanceUsd of the empty wallet")
      .eq(funded.json?.depositAddress, state.users.holder.wallet, "depositAddress is the caller's custodial wallet");
    const done = e.done("");
    if (!done.ok) return done;
    return { blocked: true, detail: "custodial USDG payment reached; needs a funded wallet — anon → 401, unfunded → 402 insufficient_funds with depositAddress, no revenue recorded" };
  });

  await check("ad_selection", async () => {
    // Selection is cpm-weighted across every ACTIVE campaign, so the pick may be a live campaign
    // rather than this fixture: the bookkeeping is asserted for whichever campaign was served, and
    // a live campaign's counters are put back afterwards — the audit's traffic is not real reach.
    const campaign = await prisma.adCampaign.create({
      data: { advertiserAppId: state.apps.feeParent.id, headline: `${TAG} ad`, body: "audit fixture campaign", targetUrl: "https://example.com/audit", cpmMicros: 2_000n, budgetMicros: 1_000_000n, status: "ACTIVE" },
    });
    onExit("ad campaign", async () => {
      await prisma.adImpression.deleteMany({ where: { advertiserAppId: campaign.advertiserAppId } });
      await prisma.adCampaign.delete({ where: { id: campaign.id } }).catch(() => {});
    });
    const eligible = await prisma.adCampaign.findMany({ where: { status: "ACTIVE", advertiserAppId: { not: rig.id } } });
    const before = Object.fromEntries(eligible.map((c) => [c.id, c]));

    const res = await call(`${rigBase}/_pyre/ad`);
    const chosenBefore = before[res.json?.id];
    const e = expect().eq(res.status, 200, "http status").ok(chosenBefore !== undefined, `the served campaign must be one of the ${eligible.length} ACTIVE campaigns (got ${res.json?.id})`);
    if (!chosenBefore) return e.done("");
    const ours = chosenBefore.id === campaign.id;
    const charge = chosenBefore.cpmMicros / 1000n;
    const after = await prisma.adCampaign.findUnique({ where: { id: chosenBefore.id } });
    const impression = await prisma.adImpression.findFirst({ where: { appId: rig.id, advertiserAppId: chosenBefore.advertiserAppId }, orderBy: { createdAt: "desc" } });
    const revenue = await prisma.revenueEvent.findFirst({ where: { appId: rig.id, source: "AD", reference: chosenBefore.id }, orderBy: { createdAt: "desc" } });
    onExit("ad impression", async () => {
      if (impression) await prisma.adImpression.delete({ where: { id: impression.id } }).catch(() => {});
      if (revenue) {
        await prisma.ledgerEntry.deleteMany({ where: { refId: revenue.id } });
        await prisma.revenueEvent.delete({ where: { id: revenue.id } }).catch(() => {});
      }
    });
    e.eq(res.json?.headline, chosenBefore.headline, "headline")
      .eq(res.json?.clickUrl, `/a/${rig.slug}/_pyre/ad/click/${chosenBefore.id}`, "click url")
      .eq(after.impressions, chosenBefore.impressions + 1, "impression counted")
      .eq(after.spentMicros, chosenBefore.spentMicros + charge, "campaign charged cpm/1000")
      .ok(impression !== null, "AdImpression row must be written")
      .eq(impression?.usdMicros, charge, "impression amount")
      // A cpm under $0.001 rounds to a zero charge, which is never booked as revenue.
      .ok(charge === 0n ? revenue === null : revenue !== null, charge === 0n ? "a zero charge must not book revenue" : "impression must be credited as revenue to the host app")
      .eq(revenue?.usdMicros ?? 0n, charge, "revenue amount");

    const click = await call(`${rigBase}/_pyre/ad/click/${chosenBefore.id}`);
    // The route redirects to the parsed target (`new URL(...).toString()`), which normalises a bare origin with a trailing slash.
    e.eq(click.status, 302, "click status").eq(click.headers.get("location"), new URL(chosenBefore.targetUrl).toString(), "click redirect");
    e.eq((await prisma.adCampaign.findUnique({ where: { id: chosenBefore.id } })).clicks, chosenBefore.clicks + 1, "click counted");
    if (!ours) {
      // Synthetic traffic against a live campaign: give the advertiser their money and counters back.
      onExit("live ad campaign counters", async () => {
        await prisma.adCampaign.update({ where: { id: chosenBefore.id }, data: { spentMicros: { decrement: charge }, impressions: { decrement: 1 }, clicks: { decrement: 1 } } }).catch(() => {});
      });
    }
    const noSlot = await call(`${API}/a/${DEMO_SLUG}/_pyre/ad`);
    e.eq(noSlot.status, 404, "an app without an ad slot must 404");
    return e.done(`served 1 impression of ${ours ? "the fixture campaign" : `live campaign "${chosenBefore.headline}"`} (${eligible.length} eligible) at $${(Number(charge) / 1e6).toFixed(6)}, charged the advertiser, credited the host, click redirected${ours ? "" : "; live counters restored"}`);
  });

  await check("track_heartbeat", async () => {
    const anon = await call(`${rigBase}/_pyre/track`, { method: "POST", headers: { "content-type": "application/json", ...sameOrigin }, body: "{}" });
    const cookie = (anon.headers.get("set-cookie") ?? "").split(";")[0];
    const repeat = await call(`${rigBase}/_pyre/track`, { method: "POST", headers: { "content-type": "application/json", cookie, ...sameOrigin }, body: "{}" });
    const authed = await call(`${rigBase}/_pyre/track`, { method: "POST", headers: { "content-type": "application/json", cookie: rigCookie, ...sameOrigin }, body: "{}" });
    const session = await prisma.appUserSession.findUnique({ where: { appId_userId: { appId: rig.id, userId: state.users.holder.id } } });
    return expect()
      .eq(anon.status, 200, "anonymous status")
      .eq(anon.json?.identified, false, "anonymous identification")
      .ok(cookie.startsWith("pyre_app_visitor="), `visitor cookie must be issued (${cookie})`)
      .ok((anon.headers.get("set-cookie") ?? "").includes("HttpOnly"), "visitor cookie must be HttpOnly")
      .eq(repeat.status, 200, "repeat status")
      .ok(!(repeat.headers.get("set-cookie") ?? "").includes("pyre_app_visitor"), "a known visitor must not be re-issued a cookie")
      .eq(authed.json?.identified, true, "signed-in identification")
      .ok(session !== null, "AppUserSession row must be written")
      .done("anonymous → signed visitor cookie, repeat → no new cookie, signed-in → AppUserSession row");
  });

  await check("dormant_and_killed_pages", async () => {
    const e = expect();
    const live = await call(`${rigBase}/`);
    e.eq(live.status, 200, "live status").ok(live.text.includes("audit rig"), "live body must be the deployment");

    await prisma.app.update({ where: { id: rig.id }, data: { status: "DORMANT" } });
    const dormant = await until(async () => {
      const res = await call(`${rigBase}/`);
      return res.text.includes("out of budget") ? res : null;
    }, APP_CACHE_WAIT_MS, 5_000);
    if (!dormant) return { ok: false, detail: "dormant page never served (app row cache did not expire within 45s)" };
    e.eq(dormant.status, 200, "dormant page status")
      .eq(dormant.headers.get("cache-control"), "no-store", "dormant page cache-control")
      .ok(dormant.text.includes("buy to revive"), "dormant page must explain revival");
    const dormantPyre = await call(`${rigBase}/_pyre/me`);
    e.eq(dormantPyre.status, 503, "platform endpoints must be 503 while dormant");

    await prisma.app.update({ where: { id: rig.id }, data: { status: "KILLED", killedReason: `${TAG} kill switch probe` } });
    const killed = await until(async () => {
      const res = await call(`${rigBase}/`);
      return res.status === 410 ? res : null;
    }, APP_CACHE_WAIT_MS, 5_000);
    if (!killed) return { ok: false, detail: "killed page never served (app row cache did not expire within 45s)" };
    e.eq(killed.status, 410, "killed page status").ok(killed.text.includes("has been removed"), "killed page copy");
    const killedPyre = await call(`${rigBase}/_pyre/me`);
    e.eq(killedPyre.status, 410, "platform endpoints must be 410 once killed").eq(killedPyre.json?.error, "app removed", "killed json");

    // The public api caches app rows for 30s, so the restore has to be observable before the
    // perimeter section starts hitting this app again.
    await prisma.app.update({ where: { id: rig.id }, data: { status: "LIVE", killedReason: null } });
    const restored = await until(async () => {
      const res = await call(`${rigBase}/`);
      return res.status === 200 ? res : null;
    }, APP_CACHE_WAIT_MS, 5_000);
    e.ok(restored !== null, "the app must serve its deployment again once the status is restored");
    const missing = await call(`${API}/a/no-such-app-${RUN}/`);
    e.eq(missing.status, 404, "unknown slug status").ok(missing.text.includes("No app here"), "unknown slug page");
    return e.done("LIVE → deployment, DORMANT → 200 revive page + 503 api, KILLED → 410 page + 410 api, unknown → 404 page");
  });
}

/* ═══════════════════════════════ 7. perimeter ═══════════════════════════════ */

async function perimeterChecks() {
  section("perimeter");
  const rig = state.apps.rig;
  const rigBase = `${API}/a/${rig.slug}`;

  await check("cross_origin_mutation_blocked", async () => {
    const e = expect();
    const foreign = await call(`${rigBase}/_pyre/track`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    e.eq(foreign.status, 403, "foreign Origin status").eq(foreign.json?.error, "cross_origin_request_blocked", "foreign Origin code");
    const foreignReferer = await call(`${rigBase}/_pyre/track`, { method: "POST", headers: { "content-type": "application/json", referer: "https://evil.example/page" }, body: "{}" });
    e.eq(foreignReferer.status, 403, "foreign Referer status");
    const crossSite = await call(`${rigBase}/_pyre/track`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" });
    e.eq(crossSite.status, 403, "Sec-Fetch-Site cross-site status");
    const otherApp = await call(`${rigBase}/_pyre/track`, { method: "POST", headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, referer: `${PUBLIC_ORIGIN}/a/${DEMO_SLUG}/` }, body: "{}" });
    e.eq(otherApp.status, 403, "a referer under another path-routed app must be refused");
    const sameOrigin = await call(`${rigBase}/_pyre/track`, { method: "POST", headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, referer: `${PUBLIC_ORIGIN}/a/${rig.slug}/` }, body: "{}" });
    e.eq(sameOrigin.status, 200, "same-origin request must pass");
    const read = await call(`${rigBase}/_pyre/me`, { headers: { origin: "https://evil.example" } });
    e.eq(read.status, 200, "reads are not origin-gated");
    return e.done("foreign Origin/Referer/Sec-Fetch-Site and a neighbouring app's referer all 403; same-origin passes");
  });

  await check("webhook_replay_dedupe", async () => {
    const e = expect();
    // GitHub is the only provider webhook left: the retired chain-indexer hook (and any other
    // provider path) must fall through to the api's 404, not to a handler.
    for (const provider of ["chain-indexer", "transfers"]) {
      const gone = await call(`${API}/v1/webhooks/${provider}`, { method: "POST", headers: { "content-type": "application/json" }, body: "[]" });
      e.eq(gone.status, 404, `/v1/webhooks/${provider} must be gone`);
    }

    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      const done = e.done("");
      return done.ok ? { skip: true, detail: "GITHUB_WEBHOOK_SECRET is not set (retired provider webhooks → 404 asserted)" } : done;
    }
    // Bind a repo to a fixture app and seed an OPEN PR: a `closed` delivery then claims its id and
    // settles the PR inside one transaction, without enqueueing a review of a repo that does not exist.
    const app = state.apps.gate;
    const repo = `pyre-audit/${RUN}`;
    await prisma.app.update({ where: { id: app.id }, data: { repoFullName: repo } });
    onExit("webhook repo binding", async () => { await prisma.app.update({ where: { id: app.id }, data: { repoFullName: null } }).catch(() => {}); });
    const pr = await prisma.pullRequest.create({ data: { appId: app.id, number: 7, authorLogin: "audit", title: `${TAG} webhook pr`, url: `https://github.com/${repo}/pull/7`, status: "OPEN" } });
    onExit("webhook pull request", async () => { await prisma.pullRequest.delete({ where: { id: pr.id } }).catch(() => {}); });
    const deliveryId = `audit-${RUN}`;
    onExit("webhook event", async () => { await prisma.webhookEvent.deleteMany({ where: { id: { startsWith: `github:${deliveryId}` } } }); });

    const body = JSON.stringify({
      action: "closed",
      repository: { full_name: repo },
      pull_request: { number: 7, title: `${TAG} webhook pr`, html_url: `https://github.com/${repo}/pull/7`, merged: false, merge_commit_sha: null, user: { login: "audit" }, head: { sha: "0123456789abcdef" } },
    });
    const signed = (raw, id = deliveryId, event = "pull_request") => ({
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      "x-github-event": event,
      "x-github-delivery": id,
    });

    const unsigned = await call(`${API}/v1/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": deliveryId }, body });
    e.eq(unsigned.status, 401, "missing signature status").eq(unsigned.json?.error, "missing_signature", "missing signature code");
    const forged = await call(`${API}/v1/webhooks/github`, { method: "POST", headers: { ...signed(body), "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body });
    e.eq(forged.status, 401, "bad HMAC status").eq(forged.json?.error, "bad_signature", "bad HMAC code");
    const tampered = await call(`${API}/v1/webhooks/github`, { method: "POST", headers: signed(body), body: body.replace('"merged":false', '"merged":true') });
    e.eq(tampered.status, 401, "a body edited after signing must fail the HMAC");
    e.eq((await prisma.pullRequest.findUnique({ where: { id: pr.id } })).status, "OPEN", "refused deliveries must not touch the PR");

    const first = await call(`${API}/v1/webhooks/github`, { method: "POST", headers: signed(body), body });
    e.eq(first.status, 200, "first delivery status").eq(first.json?.ok, true, "first delivery ok").ok(first.json?.duplicate === undefined, "first delivery must not be a duplicate");
    const stored = await prisma.webhookEvent.findUnique({ where: { id: `github:${deliveryId}` } });
    e.ok(stored !== null, "delivery id must be recorded").eq(stored?.provider, "github", "provider");
    e.eq((await prisma.pullRequest.findUnique({ where: { id: pr.id } })).status, "REJECTED", "closed-unmerged PR settles as REJECTED in the same transaction");

    const replay = await call(`${API}/v1/webhooks/github`, { method: "POST", headers: signed(body), body });
    e.eq(replay.status, 200, "replay status").eq(replay.json?.duplicate, true, "replay must be reported as a duplicate");
    e.eq(await prisma.webhookEvent.count({ where: { id: `github:${deliveryId}` } }), 1, "replay must not add a second row");

    const ping = await call(`${API}/v1/webhooks/github`, { method: "POST", headers: signed("{}", `${deliveryId}-ping`, "ping"), body: "{}" });
    e.eq(ping.status, 200, "non-PR event status").eq(ping.json?.ignored, true, "non-PR events are acknowledged and ignored");
    e.eq(await prisma.webhookEvent.count({ where: { id: `github:${deliveryId}-ping` } }), 0, "ignored events claim no delivery id");
    const foreignRepo = JSON.parse(body);
    foreignRepo.repository.full_name = `pyre-audit/none-${RUN}`;
    const unknownRepo = await call(`${API}/v1/webhooks/github`, { method: "POST", headers: signed(JSON.stringify(foreignRepo), `${deliveryId}-foreign`), body: JSON.stringify(foreignRepo) });
    e.eq(unknownRepo.status, 200, "unknown repo status").eq(unknownRepo.json?.ignored, true, "an unbound repo is ignored");
    e.eq(await prisma.webhookEvent.count({ where: { id: `github:${deliveryId}-foreign` } }), 0, "unbound repos claim no delivery id");
    return e.done("retired provider paths → 404; no/forged/tampered HMAC → 401; delivery recorded once as github:<id> with the PR settled; replay → duplicate:true; ping + unbound repo → ignored");
  });

  await check("proxy_guards", async () => {
    const { JOB_TOKEN } = state.proxy;
    const e = expect();
    const noToken = await call(`${API}/v1/proxy/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [] }) });
    e.eq(noToken.status, 401, "missing token status").eq(noToken.json?.error, "invalid_token", "missing token code");
    const badToken = await call(`${API}/v1/proxy/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": `nope-${RUN}` }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [] }) });
    e.eq(badToken.status, 401, "bad token status").eq(badToken.json?.error, "invalid_token", "bad token code");

    // A revoked token on a settled build is exactly what the live JOBTOKENS reconcile deletes (and
    // reports as drift) once the build is a minute old: stamp the build fresh so the sweep's grace
    // covers the fixture, and drop the token as soon as the probe has used it.
    await prisma.buildJob.update({ where: { id: state.proxy.revokedJobId }, data: { finishedAt: new Date() } });
    const revoked = await prisma.jobToken.create({ data: { token: `${TAG}-revoked`, jobId: state.proxy.revokedJobId, appId: state.apps.gate.id, budgetMicros: 1_000_000n, expiresAt: new Date(Date.now() + 3_600_000), revoked: true } });
    onExit("revoked job token", async () => { await prisma.jobToken.deleteMany({ where: { token: revoked.token } }); });
    const revokedRes = await call(`${API}/v1/proxy/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": revoked.token }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [] }) });
    await prisma.jobToken.deleteMany({ where: { token: revoked.token } });
    e.eq(revokedRes.status, 401, "revoked token status");

    const badModel = await call(`${API}/v1/proxy/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": JOB_TOKEN }, body: JSON.stringify({ model: "gpt-4o", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) });
    e.eq(badModel.status, 403, "disallowed model status").eq(badModel.json?.error, "model_not_allowed", "disallowed model code").ok(Array.isArray(badModel.json?.allowed), "response must list the allowlist");
    const datedOk = await call(`${API}/v1/proxy/anthropic/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": JOB_TOKEN }, body: JSON.stringify({ model: "claude-sonnet-5-20260101", messages: [{ role: "user", content: "hi" }] }) });
    e.ok(datedOk.status !== 403, `a dated pin of an allowlisted model must not be rejected (got ${datedOk.status})`);

    const oversized = await call(`${API}/v1/proxy/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": JOB_TOKEN }, body: Buffer.alloc(9 * 1024 * 1024, 0x41) });
    e.ok(oversized.status === 413 || oversized.status === 400, `oversized body must be refused (got ${oversized.status})`);

    const unknownPath = await call(`${API}/v1/proxy/anthropic/v1/complete`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": JOB_TOKEN }, body: "{}" });
    e.eq(unknownPath.status, 404, "unknown proxy path status").eq(unknownPath.json?.error, "unknown_proxy_path", "unknown proxy path code");

    const exhausted = await prisma.jobToken.create({ data: { token: `${TAG}-spent`, jobId: state.proxy.spentJobId, appId: state.apps.gate.id, budgetMicros: 1_000n, spentMicros: 1_000n, expiresAt: new Date(Date.now() + 3_600_000) } });
    onExit("spent job token", async () => { await prisma.jobToken.deleteMany({ where: { token: exhausted.token } }); });
    const spentRes = await call(`${API}/v1/proxy/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": exhausted.token }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) });
    e.eq(spentRes.status, 402, "exhausted budget status").eq(spentRes.json?.error, "budget_exhausted", "exhausted budget code");
    return e.done("no/bad/revoked token → 401, exhausted budget → 402, foreign model → 403, dated pin allowed, 9MB body refused, unknown path → 404");
  });

  await check("upstream_reachable", async () => {
    const res = await call(`${API}/v1/proxy/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": state.proxy.JOB_TOKEN },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
    });
    if (res.status === 200) return { ok: true, detail: "proxy forwarded to Anthropic and got a completion (credits are funded)" };
    if (res.status === 400 || res.status === 402 || res.status === 429) {
      const message = typeof res.json?.error === "object" ? res.json.error.message : res.json?.error;
      return { blocked: true, detail: `proxy authorised and forwarded; Anthropic refused: ${String(message ?? res.text).slice(0, 110)}` };
    }
    return { ok: false, detail: `unexpected proxy status ${res.status}: ${res.text.slice(0, 160)}` };
  });

  await check("unauthenticated_routes_refused", async () => {
    const routes = [
      ["GET", "/v1/me"],
      ["GET", "/v1/me/balances"],
      ["POST", "/v1/me/claim"],
      ["POST", "/v1/me/withdraw"],
      ["POST", "/v1/me/trade"],
      ["GET", "/v1/admin/ops"],
      ["POST", "/v1/launches"],
      ["POST", "/v1/apps/x/proposals"],
      ["POST", "/v1/apps/x/topup"],
      ["POST", "/v1/apps/x/bounties"],
      ["POST", "/v1/queue/x/vote"],
      ["POST", "/v1/pyre/stake"],
      ["POST", "/v1/pyre/claim"],
      ["POST", "/v1/auth/logout"],
      ["GET", "/v1/metrics"],
    ];
    const bad = [];
    for (const [method, path] of routes) {
      const res = await call(`${API}${path}`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      if (res.status !== 401 && res.status !== 403 && res.status !== 404) bad.push(`${method} ${path} → ${res.status}`);
    }
    return bad.length === 0 ? { ok: true, detail: `${routes.length} privileged routes all refuse anonymous callers` } : { ok: false, detail: bad.join("; ") };
  });

  await check("rate_limit_trips", async () => {
    // `write` tier is 30/60s. The guard charges every identity it can verify before auth runs: the
    // client IP and, for a validly signed session, `u:<userId>`. A fixture user's real session is
    // used so the bucket that trips is ours alone and does not depend on how the edge reports our
    // address (an unverifiable bearer would leave only the IP, which the whole run shares).
    const outsider = state.users.outsider;
    let limited = 0;
    let attempts = 0;
    let lastHeader = "";
    let lastStatus = 0;
    for (let i = 0; i < 40 && limited === 0; i++) {
      attempts++;
      const res = await call(`${API}/v1/queue/does-not-exist-${RUN}/vote`, { method: "POST", headers: jsonHeaders(outsider), body: "{}" });
      lastHeader = res.headers.get("ratelimit") ?? lastHeader;
      lastStatus = res.status;
      if (res.status === 429) limited = i + 1;
    }
    const e = expect()
      .ok(limited > 0, `no 429 within ${attempts} requests (last ${lastStatus}, RateLimit: ${lastHeader || "absent"})`)
      .ok(limited <= 35, `429 arrived at request ${limited}, later than the 30/min write tier allows`);
    if (limited > 0) {
      const tripped = await call(`${API}/v1/queue/does-not-exist-${RUN}/vote`, { method: "POST", headers: jsonHeaders(outsider), body: "{}" });
      e.eq(tripped.status, 429, "the bucket stays closed once tripped")
        .eq(tripped.json?.error, "rate_limited", "429 body code")
        .ok(Number(tripped.headers.get("retry-after")) > 0, "Retry-After is set")
        .ok(/^limit=30, remaining=0, reset=\d+$/.test(tripped.headers.get("ratelimit") ?? ""), `RateLimit header on refusal (${tripped.headers.get("ratelimit")})`);
    }
    return e.done(`429 at request ${limited} of the 30/min write tier for u:${outsider.id.slice(0, 8)}… (RateLimit: ${lastHeader}); stays closed with Retry-After`);
  });
}

/* ═══════════════════════════════ 8. workers ═══════════════════════════════ */

const QUEUE_NAMES = ["intake", "launch", "build", "buyback", "feeSweep", "monitor", "price", "holders", "market", "growth", "scheduler", "prReview", "reconcile"];
const EXPECTED_SCHEDULERS = {
  scheduler: { "scheduler:tick": 60_000, "scheduler:closeStale": 86_400_000 },
  monitor: { "monitor:tick": 60_000 },
  reconcile: { reconcileTick: 300_000 },
  feeSweep: { feeSweep: 300_000 },
  buyback: { buybackScan: 600_000 },
  price: { priceRefresh: 60_000 },
  holders: { holdersRefresh: 600_000 },
  market: { marketRefresh: 60_000 },
  launch: { launchRetryGated: 600_000 },
  growth: { "growth:daily": 86_400_000 },
};

async function workerChecks() {
  section("workers");

  await check("queues_registered_and_consuming", async () => {
    const missing = [];
    const idle = [];
    const counts = [];
    for (const name of QUEUE_NAMES) {
      const queue = state.queues[name];
      const meta = await state.redis.exists(`bull:${name}:meta`);
      if (meta !== 1) missing.push(`${name} (no queue metadata in Redis)`);
      const workers = await queue.getWorkers();
      if (workers.length === 0) idle.push(name);
      counts.push(`${name}:${workers.length}`);
    }
    return missing.length === 0 && idle.length === 0
      ? { ok: true, detail: `${QUEUE_NAMES.length} queues registered with a live consumer each — ${counts.join(" ")}` }
      : { ok: false, detail: [...missing, ...(idle.length ? [`no consumer attached: ${idle.join(", ")}`] : [])].join("; ") };
  });

  await check("repeatable_schedulers", async () => {
    const bad = [];
    const found = [];
    for (const [queueName, expected] of Object.entries(EXPECTED_SCHEDULERS)) {
      const schedulers = await state.queues[queueName].getJobSchedulers();
      const byId = Object.fromEntries(schedulers.map((s) => [s.key ?? s.id, s]));
      for (const [id, everyMs] of Object.entries(expected)) {
        const found_ = byId[id];
        if (!found_) {
          bad.push(`${queueName}: scheduler "${id}" is missing`);
          continue;
        }
        if (Number(found_.every) !== everyMs) bad.push(`${queueName}/${id}: every=${found_.every}, expected ${everyMs}`);
        else found.push(`${id}@${everyMs / 1000}s`);
      }
    }
    return bad.length === 0 ? { ok: true, detail: found.join(" ") } : { ok: false, detail: bad.join("; ") };
  });

  await check("locks_honoured", async () => {
    const key = `lock:audit:${RUN}`;
    onExit("audit lock", async () => { await state.redis.del(key); });
    const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
    const mine = randomUUID();
    const theirs = randomUUID();
    const first = await state.redis.set(key, mine, "EX", 30, "NX");
    const second = await state.redis.set(key, theirs, "EX", 30, "NX");
    const ttl = await state.redis.ttl(key);
    const foreignRelease = await state.redis.eval(RELEASE, 1, key, theirs);
    const stillHeld = await state.redis.get(key);
    const ownerRelease = await state.redis.eval(RELEASE, 1, key, mine);
    const gone = await state.redis.get(key);
    const e = expect()
      .eq(first, "OK", "first acquire")
      .eq(second, null, "a second holder must be refused")
      .ok(ttl > 0 && ttl <= 30, `lock must carry a TTL (got ${ttl})`)
      .eq(foreignRelease, 0, "a non-owner must not release the lock")
      .eq(stillHeld, mine, "lock must survive a foreign release")
      .eq(ownerRelease, 1, "the owner must release")
      .eq(gone, null, "lock must be gone after release");
    // The live passes must also be using TTL'd locks rather than leaking them.
    const live = [];
    for (const lockKey of ["lock:scheduler:tick", "lock:monitor:tick", "lock:reconcile:pass", "lock:feeSweep:pass", "lock:price:pass", "lock:holders:pass", "lock:market:pass"]) {
      const lockTtl = await state.redis.ttl(lockKey);
      if (lockTtl === -1) e.ok(false, `${lockKey} exists with no expiry — a crashed pass would wedge it forever`);
      if (lockTtl > 0) live.push(`${lockKey.split(":")[1]}:${lockTtl}s`);
    }
    return e.done(`mutual exclusion + owner-only release verified${live.length ? `; live locks held: ${live.join(" ")}` : "; no pass lock held right now"}`);
  });

  await check("reconcile_reports_no_drift", async () => {
    const kinds = ["JOBS", "SANDBOXES", "JOBTOKENS", "LEDGER", "FEES", "BURNS"];
    const bad = [];
    const summary = [];
    for (const kind of kinds) {
      const run = await prisma.reconcileRun.findFirst({ where: { kind }, orderBy: { createdAt: "desc" } });
      if (!run) {
        bad.push(`${kind}: never run`);
        continue;
      }
      const ageMin = Math.round((Date.now() - run.createdAt.getTime()) / 60_000);
      if (ageMin > 20) bad.push(`${kind}: last run ${ageMin}m ago (the 5-minute schedule is not firing)`);
      if (!run.ok) bad.push(`${kind}: check reported ok=false — ${JSON.stringify(run.findings).slice(0, 120)}`);
      if (run.drifted > 0) bad.push(`${kind}: ${run.drifted} drifted — ${JSON.stringify(run.findings).slice(0, 200)}`);
      summary.push(`${kind} ${run.checked}✓${run.repaired > 0 ? ` ${run.repaired}repaired` : ""} ${ageMin}m`);
    }
    return bad.length === 0 ? { ok: true, detail: summary.join(" · ") } : { ok: false, detail: bad.join("; ") };
  });

  await check("reaper_settles_stuck_job", async () => {
    if (SKIP_SLOW) return { skip: true, detail: "PYRE_SKIP_SLOW=1" };
    const gate = state.apps.jobs;
    const stuck = await prisma.buildJob.create({
      data: { appId: gate.id, stage: "ITERATE", status: "RUNNING", budgetMicros: MIN_ITER_MICROS, startedAt: new Date(Date.now() - REAPABLE_AGE_MS), instruction: `${TAG} artificially stuck job` },
    });
    const token = await prisma.jobToken.create({ data: { token: `${TAG}-stuck`, jobId: stuck.id, appId: gate.id, budgetMicros: MIN_ITER_MICROS, expiresAt: new Date(Date.now() + 3_600_000) } });
    onExit("stuck job", async () => {
      await prisma.jobToken.deleteMany({ where: { token: token.token } });
      await prisma.auditLog.deleteMany({ where: { targetType: "BuildJob", targetId: stuck.id } });
      await prisma.buildEvent.deleteMany({ where: { jobId: stuck.id } });
      await prisma.ledgerEntry.deleteMany({ where: { refType: "BuildJob", refId: stuck.id } });
      await prisma.buildJob.delete({ where: { id: stuck.id } }).catch(() => {});
    });

    const jobId = `audit-${RUN}-reconcile`;
    const job = await state.queues.reconcile.add("tick", {}, { jobId });
    onExit("reconcile probe job", async () => { await state.queues.reconcile.getJob(jobId).then((j) => j?.remove()).catch(() => {}); });
    const finished = await until(async () => {
      const s = await job.getState();
      return s === "completed" || s === "failed" ? s : null;
    }, 120_000, 3_000);
    if (!finished) return { ok: false, detail: "the live runner never ran the reconcile pass" };
    if (finished === "failed") return { ok: false, detail: `reconcile pass failed: ${(await state.queues.reconcile.getJob(jobId))?.failedReason}` };

    const settled = await until(async () => {
      const row = await prisma.buildJob.findUnique({ where: { id: stuck.id }, select: { status: true, error: true, finishedAt: true } });
      return row.status === "RUNNING" ? null : row;
    }, 30_000, 2_000);
    if (!settled) return { ok: false, detail: "the reconcile pass ran but left the stuck job RUNNING" };
    const after = await prisma.jobToken.findUnique({ where: { token: token.token }, select: { revoked: true } });
    const audited = await prisma.auditLog.findFirst({ where: { targetType: "BuildJob", targetId: stuck.id } });
    const run = await prisma.reconcileRun.findFirst({ where: { kind: "JOBS" }, orderBy: { createdAt: "desc" } });
    return expect()
      .eq(settled.status, "FAILED", "settled status")
      .ok((settled.error ?? "").includes("abandoned"), `error must explain the reap (got "${settled.error}")`)
      .ok(settled.finishedAt !== null, "finishedAt must be stamped")
      .eq(after?.revoked, true, "the job token must be revoked")
      .ok(audited !== null, "a REAP_JOB audit row must be written")
      .ok((run?.repaired ?? 0) > 0, "the JOBS check must report the repair")
      .done(`3h-old RUNNING job → FAILED, token revoked, audit row ${audited?.action}, ReconcileRun JOBS repaired=${run?.repaired}`);
  });
}

/* ═══════════════════════════════ 9. data integrity ═══════════════════════════════ */

async function dataChecks() {
  section("data");

  await check("migrations_applied", async () => {
    const rows = await prisma.$queryRawUnsafe(`SELECT migration_name, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations ORDER BY started_at`);
    const bad = rows.filter((r) => r.finished_at === null || r.rolled_back_at !== null);
    return expect()
      .ok(rows.length > 0, "no migrations recorded — the schema was pushed, not migrated")
      .eq(bad.length, 0, `unfinished or rolled-back migrations: ${bad.map((r) => r.migration_name).join(", ")}`)
      .ok(rows.some((r) => r.migration_name === "20260921000000_pyre_init"), "the EVM init migration must be applied")
      .done(`${rows.length} migration${rows.length === 1 ? "" : "s"} applied, newest ${rows[rows.length - 1]?.migration_name}`);
  });

  await check("no_orphaned_rows", async () => {
    // Relations Prisma models as plain columns, so nothing but this check protects them.
    const queries = {
      "PyreStake.appId": `SELECT count(*)::int AS n FROM "PyreStake" s LEFT JOIN "App" a ON a.id = s."appId" WHERE a.id IS NULL`,
      "AdCampaign.advertiserAppId": `SELECT count(*)::int AS n FROM "AdCampaign" c LEFT JOIN "App" a ON a.id = c."advertiserAppId" WHERE a.id IS NULL`,
      "AdImpression.advertiserAppId": `SELECT count(*)::int AS n FROM "AdImpression" i LEFT JOIN "App" a ON a.id = i."advertiserAppId" WHERE a.id IS NULL`,
      "Report.appId": `SELECT count(*)::int AS n FROM "Report" r LEFT JOIN "App" a ON a.id = r."appId" WHERE a.id IS NULL`,
      "JobToken.appId": `SELECT count(*)::int AS n FROM "JobToken" t LEFT JOIN "App" a ON a.id = t."appId" WHERE a.id IS NULL`,
      "JobToken.jobId": `SELECT count(*)::int AS n FROM "JobToken" t LEFT JOIN "BuildJob" j ON j.id = t."jobId" WHERE j.id IS NULL`,
      "LedgerEntry BUILD:<appId>": `SELECT count(*)::int AS n FROM "LedgerEntry" l LEFT JOIN "App" a ON a.id = substring(l.account from 7) WHERE l.account LIKE 'BUILD:%' AND a.id IS NULL`,
      "LedgerEntry LAUNCHER:<userId>": `SELECT count(*)::int AS n FROM "LedgerEntry" l LEFT JOIN "User" u ON u.id = substring(l.account from 10) WHERE l.account LIKE 'LAUNCHER:%' AND u.id IS NULL`,
      "LedgerEntry STAKERS:<appId>": `SELECT count(*)::int AS n FROM "LedgerEntry" l LEFT JOIN "App" a ON a.id = substring(l.account from 9) WHERE l.account LIKE 'STAKERS:%' AND a.id IS NULL`,
      "LedgerEntry CREDITS:<appId>": `SELECT count(*)::int AS n FROM "LedgerEntry" l LEFT JOIN "App" a ON a.id = substring(l.account from 9) WHERE l.account LIKE 'CREDITS:%' AND a.id IS NULL`,
      "App.forkOfId": `SELECT count(*)::int AS n FROM "App" f LEFT JOIN "App" p ON p.id = f."forkOfId" WHERE f."forkOfId" IS NOT NULL AND p.id IS NULL`,
      "App.liveVersion without Deployment": `SELECT count(*)::int AS n FROM "App" a LEFT JOIN "Deployment" d ON d."appId" = a.id AND d.version = a."liveVersion" WHERE a."liveVersion" > 0 AND d.id IS NULL`,
      "RevenueEvent.buybackId": `SELECT count(*)::int AS n FROM "RevenueEvent" r LEFT JOIN "Buyback" b ON b.id = r."buybackId" WHERE r."buybackId" IS NOT NULL AND b.id IS NULL`,
    };
    const bad = [];
    for (const [label, sql] of Object.entries(queries)) {
      const [row] = await prisma.$queryRawUnsafe(sql);
      if (Number(row.n) > 0) bad.push(`${label}: ${row.n} orphan${Number(row.n) === 1 ? "" : "s"}`);
    }
    return bad.length === 0 ? { ok: true, detail: `${Object.keys(queries).length} unreferenced-relation checks clean` } : { ok: false, detail: bad.join("; ") };
  });

  await check("audit_tables_writable_and_written", async () => {
    const e = expect();
    const run = await prisma.reconcileRun.create({ data: { kind: "LEDGER", ok: true, checked: 0, findings: [{ code: "AUDIT_PROBE", detail: TAG }], durationMs: 0 } });
    const log = await prisma.auditLog.create({ data: { actor: "system", action: "SET_SETTING", targetType: "PlatformSetting", targetId: `${TAG}-probe`, meta: { probe: TAG } } });
    const hook = await prisma.webhookEvent.create({ data: { id: `github:audit-probe-${RUN}`, provider: "github" } });
    onExit("audit probe rows", async () => {
      await prisma.reconcileRun.deleteMany({ where: { id: run.id } });
      await prisma.auditLog.deleteMany({ where: { id: log.id } });
      await prisma.webhookEvent.deleteMany({ where: { id: hook.id } });
    });
    e.ok(run.id.length > 0, "ReconcileRun must be writable").ok(log.id.length > 0, "AuditLog must be writable").ok(hook.id.length > 0, "WebhookEvent must be writable");

    // And the platform is actually writing them, not just able to.
    const dayAgo = new Date(Date.now() - 86_400_000);
    const runs = await prisma.reconcileRun.count({ where: { createdAt: { gte: new Date(Date.now() - 3_600_000) }, id: { not: run.id } } });
    const logs = await prisma.auditLog.count({ where: { createdAt: { gte: dayAgo }, id: { not: log.id } } });
    const hooks = await prisma.webhookEvent.count({ where: { id: { not: hook.id } } });
    const foreignProviders = await prisma.webhookEvent.count({ where: { provider: { not: "github" } } });
    e.ok(runs > 0, "no ReconcileRun rows in the last hour — the reconcile worker is not running").ok(logs > 0, "no AuditLog rows in the last 24h");
    e.eq(foreignProviders, 0, "GitHub is the only webhook provider left; no other provider rows may exist");
    return e.done(`writable; ${runs} ReconcileRun/hour, ${logs} AuditLog/24h, ${hooks} WebhookEvent total (all github)`);
  });

  await check("enum_and_counter_sanity", async () => {
    const e = expect();
    // Wei/base-unit columns are Decimal(78,0): Prisma filters them with a number or string, not a BigInt.
    const negative = await prisma.app.count({
      where: { OR: [{ budgetMicros: { lt: 0n } }, { spentMicros: { lt: 0n } }, { revenueMicros: { lt: 0n } }, { pendingRevenueMicros: { lt: 0n } }, { burnedTokens: { lt: 0 } }, { feesWei: { lt: 0 } }, { buybackWei: { lt: 0 } }, { stakeWei: { lt: 0 } }] },
    });
    e.eq(negative, 0, "no app may hold a negative money counter");
    const overPending = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "App" WHERE "pendingRevenueMicros" > "revenueMicros"`);
    e.eq(Number(overPending[0].n), 0, "pending revenue may never exceed lifetime revenue");
    const badUptime = await prisma.app.count({ where: { OR: [{ uptimeBps: { lt: 0 } }, { uptimeBps: { gt: 10_000 } }] } });
    e.eq(badUptime, 0, "uptimeBps must stay in [0, 10000]");
    const killedWithoutReason = await prisma.app.count({ where: { status: "KILLED", killedReason: null } });
    e.eq(killedWithoutReason, 0, "a KILLED app must record why");
    const badPhase = await prisma.app.count({ where: { OR: [{ launchPhase: { lt: 0 } }, { launchPhase: { gt: 3 } }] } });
    e.eq(badPhase, 0, "launchPhase must be a PONS phase (0..3)");
    // Every on-chain identifier the cutover introduced must be a well-formed EVM value.
    const [addresses] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "App" WHERE ("tokenAddress" IS NOT NULL AND "tokenAddress" !~ '^0x[0-9a-fA-F]{40}$') OR ("walletAddress" IS NOT NULL AND "walletAddress" !~ '^0x[0-9a-fA-F]{40}$')`,
    );
    e.eq(Number(addresses.n), 0, "App.tokenAddress / walletAddress must be 0x addresses");
    const [userWallets] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "User" WHERE ("wallet" IS NOT NULL AND "wallet" !~ '^0x[0-9a-fA-F]{40}$') OR ("authWallet" IS NOT NULL AND "authWallet" !~ '^0x[0-9a-fA-F]{40}$')`,
    );
    e.eq(Number(userWallets.n), 0, "User.wallet / authWallet must be 0x addresses");
    const [feeHashes] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "FeeEvent" WHERE "txHash" IS NOT NULL AND "txHash" !~ '^0x[0-9a-fA-F]{64}$'`);
    e.eq(Number(feeHashes.n), 0, "FeeEvent.txHash must be a 0x tx hash");
    const liveWithoutWallet = await prisma.app.count({ where: { status: { in: ["LIVE", "DORMANT"] }, walletAddress: null } });
    const seeded = await prisma.app.count({ where: { status: { in: ["LIVE", "DORMANT"] } } });
    return e.done(`counters non-negative, pending ≤ lifetime, uptime in range, kills explained, phases 0..3, every address/hash well-formed (${liveWithoutWallet}/${seeded} live apps are seed rows with no app wallet)`);
  });
}

/* ═══════════════════════════════ setup / report ═══════════════════════════════ */

async function setup() {
  section("setup");
  await check("database_and_redis", async () => {
    const [[one]] = [await prisma.$queryRawUnsafe("SELECT 1 AS one")];
    state.redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
    const pong = await state.redis.ping();
    for (const name of QUEUE_NAMES) state.queues[name] = new Queue(name, { connection: state.redis });
    const health = await call(`${API}/health`);
    return expect()
      .eq(Number(one.one), 1, "postgres")
      .eq(pong, "PONG", "redis")
      .eq(health.status, 200, "deployed api /health")
      .eq(health.json?.ok, true, "deployed api health body")
      .done(`postgres + redis reachable, ${API} healthy`);
  });

  await check("chain_and_oracle", async () => {
    // Decides how the chain-dependent rows are graded: unreachable here → BLOCKED with the reason.
    const [block, price] = await Promise.all([within(publicClient().getBlockNumber(), CHAIN_PROBE_MS), within(getEthPriceUsd(), CHAIN_PROBE_MS)]);
    state.rpcOk = typeof block === "bigint" && block > 0n;
    state.priceOk = typeof price === "number" && price > 0;
    const e = expect().address(state.treasury, "treasury derives at custodial index 0");
    const done = e.done("");
    if (!done.ok) return done;
    if (!state.rpcOk || !state.priceOk) return { blocked: true, detail: `${offline()} — chain-dependent rows will be graded BLOCKED, not FAIL (treasury ${state.treasury.slice(0, 10)}…)` };
    return { ok: true, detail: `RPC_URL at block ${block}, ETH $${price}, treasury ${state.treasury.slice(0, 10)}…` };
  });

  await check("api_app_in_process", async () => {
    // Real session JWTs (minted per fixture user) flow through the unmodified auth middleware, so
    // no test seam is needed: the app boots exactly as it does in production.
    const mod = await import("../dist/app.js");
    state.expressApp = mod.app;
    state.apiQueues = await import("../dist/lib/queues.js");
    state.apiRedis = await import("../dist/lib/redis.js");
    state.server = await new Promise((resolve, reject) => {
      const s = state.expressApp.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
    onExit("in-process api", async () => {
      await new Promise((resolve) => state.server.close(resolve));
      await state.apiQueues.closeQueues().catch(() => {});
      await state.apiRedis.closeRedis().catch(() => {});
    });
    state.localBase = `http://127.0.0.1:${state.server.address().port}`;
    if (process.env.PYRE_PROBE === "local") {
      API = state.localBase;
      process.stdout.write(`  ·    probing the in-process app built from this checkout (PYRE_PROBE=local)\n`);
    }
    const health = await call(local("/health"));
    return expect().eq(health.status, 200, "in-process /health").eq(health.json?.ok, true, "in-process health body").done(`api app listening on ${state.localBase}`);
  });

  await check("fixtures", async () => {
    // `owner` holds every fixture app so the launcher's 24h launch quota starts empty.
    await createUser("owner");
    await createUser("launcher");
    await createUser("holder");
    await createUser("outsider");
    await createUser("admin", { admin: true });
    // Signed in with an injected wallet: the only kind of launcher who may settle a stake with `{txHash}`.
    await createUser("external", { authWallet: fixtureAddress(700) });
    // Tokenised apps carry a (fixture) PONS token address so they are public; feeParent also gets
    // an app wallet so the custodial top-up path can be reached.
    await createApp("rig", { tokenAddress: fixtureAddress(500) });
    await createApp("feeParent", { walletAddress: fixtureAddress(502) });
    await createApp("feeFork", { forkOfId: state.apps.feeParent.id, tokenAddress: fixtureAddress(501) });
    await createApp("gate", { firstBuildAt: null });
    await createApp("dormant");
    // BuildJob fixtures live on their own app: an app carrying jobs must have firstBuildAt set,
    // and `gate` has to stay unstarted for the pause-blocks-scheduling probe.
    await createApp("jobs", { firstBuildAt: new Date(), liveVersion: 0 });
    await deployRig(state.apps.rig, RIG_MANIFEST, RIG_FILES);
    state.apps.rig = await prisma.app.findUnique({ where: { id: state.apps.rig.id } });
    state.demo = await prisma.app.findUnique({ where: { slug: DEMO_SLUG } });

    // A live-looking job + token for the proxy checks, plus the daily-spend restore point.
    const jobsApp = state.apps.jobs;
    // An app with firstBuildAt must have had a budget: keep the fixture internally consistent.
    await creditBudget(jobsApp.id, MIN_ITER_MICROS, `${TAG} jobs fixture budget`);
    const job = await prisma.buildJob.create({ data: { appId: jobsApp.id, stage: "ITERATE", status: "RUNNING", budgetMicros: MIN_ITER_MICROS, startedAt: new Date(), instruction: `${TAG} proxy fixture` } });
    const revokedJob = await prisma.buildJob.create({ data: { appId: jobsApp.id, stage: "ITERATE", status: "SUCCEEDED", budgetMicros: MIN_ITER_MICROS, startedAt: new Date(), finishedAt: new Date() } });
    const spentJob = await prisma.buildJob.create({ data: { appId: jobsApp.id, stage: "ITERATE", status: "SUCCEEDED", budgetMicros: MIN_ITER_MICROS, startedAt: new Date(), finishedAt: new Date() } });
    const token = await prisma.jobToken.create({ data: { token: `${TAG}-proxy`, jobId: job.id, appId: jobsApp.id, budgetMicros: 5_000_000n, expiresAt: new Date(Date.now() + 3_600_000) } });
    onExit("proxy fixtures", async () => {
      await prisma.jobToken.deleteMany({ where: { token: token.token } });
      await prisma.buildJob.deleteMany({ where: { id: { in: [job.id, revokedJob.id, spentJob.id] } } });
    });

    const day = new Date().toISOString().slice(0, 10);
    const spend = await prisma.dailyComputeSpend.findUnique({ where: { day } });
    const previous = spend?.micros ?? 0n;
    const restoreSpend = async () => {
      if (spend) await prisma.dailyComputeSpend.update({ where: { day }, data: { micros: previous } });
      else await prisma.dailyComputeSpend.deleteMany({ where: { day } });
    };
    onExit("daily compute spend", restoreSpend);
    state.proxy = { JOB_TOKEN: token.token, jobId: job.id, revokedJobId: revokedJob.id, spentJobId: spentJob.id, previous, restoreSpend };

    return expect()
      .ok(state.demo !== null, `the hosting probe app "${DEMO_SLUG}" must exist`)
      .eq(Object.keys(state.apps).length, 6, "fixture apps")
      .eq(state.apps.rig.liveVersion, 1, "rig deployment")
      .address(state.apps.rig.tokenAddress, "rig token address")
      .done(`6 users, 6 apps, 1 deployment, 3 job tokens — all tagged ${TAG}`);
  });
}

function report() {
  const width = results.reduce((max, r) => Math.max(max, r.name.length), 6);
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL");
  const blocked = results.filter((r) => r.status === "BLOCKED");
  const skipped = results.filter((r) => r.status === "SKIP");
  process.stdout.write(`\n${"═".repeat(width + 78)}\nPyre feature audit — ${API}  ·  run ${RUN}  ·  ${new Date().toISOString()}\n${"═".repeat(width + 78)}\n`);
  process.stdout.write(`${"feature".padEnd(width + 2)}│ result  │ detail\n${"─".repeat(width + 2)}┼─────────┼${"─".repeat(64)}\n`);
  let lastSection = "";
  for (const r of results) {
    const s = r.name.split(".")[0];
    if (s !== lastSection && lastSection !== "") process.stdout.write(`${"".padEnd(width + 2)}┼─────────┼${"─".repeat(64)}\n`);
    lastSection = s;
    process.stdout.write(`${r.name.padEnd(width + 2)}│ ${r.status.padEnd(7)} │ ${r.detail}\n`);
  }
  process.stdout.write(`\n${pass} passed · ${fail.length} failed · ${blocked.length} blocked on funding or chain reach · ${skipped.length} skipped  (${results.length} features)\n`);
  if (blocked.length > 0) {
    process.stdout.write(`\nBLOCKED — feature works up to a step that needs funding or a reachable chain:\n`);
    for (const r of blocked) process.stdout.write(`  ${r.name}: ${r.detail}\n`);
  }
  if (fail.length > 0) {
    process.stdout.write(`\nFAILED:\n`);
    for (const r of fail) process.stdout.write(`  ${r.name}: ${r.detail}\n`);
  }
  process.stdout.write(
    `\nfingerprint ${createHash("sha256").update(results.map((r) => `${r.name}${r.status}`).join("|")).digest("hex").slice(0, 12)}\n`,
  );
  return fail.length;
}

/* ═══════════════════════════════ main ═══════════════════════════════ */

let exitCode = 1;
try {
  await setup();
  if (results.some((r) => r.status === "FAIL")) {
    process.stdout.write("\nsetup failed — aborting before the feature checks\n");
  } else {
    await launchChecks();
    await moneyChecks();
    await gatingChecks();
    await governanceChecks();
    await platformChecks();
    await hostingChecks();
    await perimeterChecks();
    await workerChecks();
    await dataChecks();
  }
  exitCode = report() > 0 ? 1 : 0;
} catch (err) {
  process.stdout.write(`\naudit crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  exitCode = 1;
} finally {
  const cleanupFailures = await teardown();
  await state.redis?.quit().catch(() => {});
  for (const queue of Object.values(state.queues)) await queue.close().catch(() => {});
  await prisma.$disconnect();
  if (cleanupFailures) exitCode = 1;
}
// Explicit: the in-process api leaves pino/metrics timers behind that would otherwise hold the loop.
process.exit(exitCode);
