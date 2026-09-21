import { prisma } from "@pyre/db";
import { AppSpec, ModerationVerdict, SPEC_INTAKE_BUDGET_USD } from "@pyre/shared";
import { Worker } from "bullmq";
import { z } from "zod";
import { models } from "../env.js";
import { askJson } from "../lib/anthropic.js";
import { audit } from "../lib/audit.js";
import { addDailyCompute } from "../lib/compute.js";
import { maxTokensForBudget } from "../lib/pricing.js";
import { publishEvent } from "../lib/publishEvent.js";
import type { WorkerContext } from "../lib/queues.js";

const IntakeJob = z.object({ appId: z.string() });

const MODERATION_SYSTEM = `You are the content moderator for Pyre, a public launchpad on Robinhood Chain where anyone can fund an AI-built web app by launching a coin. Classify the launch request. Disallow: scams and rug pulls, phishing or credential harvesting, impersonation of real brands/people/projects, real-money gambling, illegal goods/services, sexual content, hate or harassment, malware, market manipulation tooling, anything targeting minors. Allow ordinary tools, games, content apps, utilities, AI assistants and API products. Choose category OK when allowed. Keep the reason under 300 characters.`;

const INTAKE_SYSTEM = `You are the product lead for Pyre. Turn a launcher's short pitch into a concrete, buildable spec for a small web app (Vite + React static site with optional server functions) that an autonomous coding agent will build in one session with about $50 of compute and later iterate on.

Rules:
- The MVP list is 3-6 concrete, testable features that can ship in one session. Prefer one sharp use case over breadth.
- Pick the monetization model that fits who pays: ONE_TIME or SUBSCRIPTION (USDG checkout on Robinhood Chain), PAY_PER_REQUEST (per-call API priced in USDG), ADS (free with an ad slot), HOLDER_TIER (free, pro features gated by holding the coin). priceUsd is null for ADS and HOLDER_TIER.
- The app cannot call external APIs, run its own backend, use OAuth, or store secrets. Server logic runs in platform functions with a key-value store and an LLM call. Design within those limits.
- No auth, wallet or payment code is written by the agent; the platform SDK provides login, checkout, holder checks and ads.
- Title ≤ 60 chars, oneLiner ≤ 140 chars, plain language, no hype.
- template: GAME for games, AGENT_API for pay-per-request APIs, else WEB_TOOL.
- risks: honest, short.`;

export const registerIntakeWorker = ({ redis, log }: WorkerContext): Worker[] => {
  const worker = new Worker(
    "intake",
    async (job) => {
      const { appId } = IntakeJob.parse(job.data);
      const app = await prisma.app.findUnique({ where: { id: appId } });
      if (!app) {
        log.warn({ appId }, "intake: app missing");
        return;
      }
      if (app.status !== "DRAFT") {
        log.info({ appId, status: app.status }, "intake: app not DRAFT; skipping");
        return;
      }
      const jlog = log.child({ appId, queue: "intake" });
      const pitch = `Name: ${app.name}\nTicker: ${app.ticker}\nTemplate hint: ${app.template}\n\nPrompt:\n${app.prompt}`;

      const moderation = await askJson({
        model: models.CLASSIFIER,
        system: MODERATION_SYSTEM,
        user: pitch,
        schema: ModerationVerdict,
        maxTokens: 512,
        toolName: "submit_verdict",
      });
      await addDailyCompute(moderation.costMicros);
      if (!moderation.value.allowed) {
        await prisma.$transaction([
          prisma.app.update({ where: { id: appId }, data: { status: "FAILED", killedReason: moderation.value.reason } }),
          prisma.abuseFlag.create({
            data: { appId, source: "CLASSIFIER", category: moderation.value.category, reason: moderation.value.reason },
          }),
        ]);
        await audit({
          actor: "worker:intake",
          action: "APP_STATUS",
          targetType: "App",
          targetId: appId,
          meta: { from: "DRAFT", to: "FAILED", reason: moderation.value.reason, category: moderation.value.category },
        });
        await publishEvent(appId, {
          type: "AGENT_NOTE",
          text: `Launch rejected by moderation (${moderation.value.category}): ${moderation.value.reason}`,
        });
        jlog.info({ category: moderation.value.category }, "intake: rejected by classifier");
        return;
      }

      const specBudget = Math.max(0.05, SPEC_INTAKE_BUDGET_USD - Number(moderation.costMicros) / 1e6);
      const spec = await askJson({
        model: models.INTAKE,
        system: INTAKE_SYSTEM,
        user: pitch,
        schema: AppSpec,
        maxTokens: maxTokensForBudget(models.INTAKE, specBudget, 4096),
        toolName: "submit_spec",
        toolDescription: "Submit the finished product spec.",
      });
      await addDailyCompute(spec.costMicros);
      await prisma.app.update({
        where: { id: appId },
        data: { spec: spec.value, template: spec.value.template, status: "SPEC_READY" },
      });
      await publishEvent(appId, { type: "AGENT_NOTE", text: `Spec ready: ${spec.value.title} — ${spec.value.oneLiner}` });
      jlog.info({ costMicros: (moderation.costMicros + spec.costMicros).toString() }, "intake: spec ready");
    },
    { connection: redis, concurrency: 4 },
  );
  // A provider outage must not leave a launcher staring at "generating spec"
  // forever: once retries are exhausted, settle the app so the wizard can show
  // a real failure. No coin exists yet and no stake was taken at this point.
  worker.on("failed", async (job, err) => {
    log.error({ jobId: job?.id, err }, "intake job failed");
    if (!job) return;
    const attemptsAllowed = job.opts.attempts ?? 1;
    if (job.attemptsMade < attemptsAllowed) return;
    const parsed = IntakeJob.safeParse(job.data);
    if (!parsed.success) return;
    const { appId } = parsed.data;
    const settled = await prisma.app.updateMany({
      where: { id: appId, status: "DRAFT" },
      data: { status: "FAILED", killedReason: "Spec generation is unavailable right now. Nothing was launched or charged." },
    });
    if (settled.count === 0) return;
    await audit({
      actor: "worker:intake",
      action: "APP_STATUS",
      targetType: "App",
      targetId: appId,
      meta: { from: "DRAFT", to: "FAILED", reason: "spec generation unavailable after exhausting retries" },
    });
    await publishEvent(appId, {
      type: "AGENT_NOTE",
      text: "Spec generation failed: the intake agent could not be reached. Nothing was launched or charged — try again.",
    });
    log.warn({ appId }, "intake: settled app as FAILED after exhausting retries");
  });
  return [worker];
};
