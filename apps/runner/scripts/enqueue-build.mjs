#!/usr/bin/env node
/**
 * Queue a build for a LIVE app now, bypassing the scheduler's retry backoff.
 *
 *   railway ssh --service runner -- node apps/runner/scripts/enqueue-build.mjs <slug> [MVP|ITERATE]
 */
import { prisma } from "@pyre/db";
import { enqueueBuildJob } from "../dist/workers/scheduler.js";

const [slug, stage = "MVP"] = process.argv.slice(2);
if (!slug) throw new Error("usage: enqueue-build.mjs <slug> [stage]");
const app = await prisma.app.findUnique({ where: { slug } });
if (!app) throw new Error(`no app ${slug}`);
if (app.status !== "LIVE") throw new Error(`app is ${app.status}`);
const running = await prisma.buildJob.count({ where: { appId: app.id, status: { in: ["RUNNING", "QUEUED"] } } });
if (running > 0) throw new Error("a build is already queued or running");
const budget = app.budgetMicros < 50_000_000n ? app.budgetMicros : 50_000_000n;
const id = await enqueueBuildJob({ app, stage, budgetMicros: budget, appData: app.firstBuildAt ? undefined : { firstBuildAt: new Date() } });
console.log(`queued ${stage} build ${id} for ${slug} with $${Number(budget) / 1e6}`);
await prisma.$disconnect();
process.exit(0);
