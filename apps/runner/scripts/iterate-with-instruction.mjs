#!/usr/bin/env node
/** Queue an ITERATE build with an explicit instruction: node apps/runner/scripts/iterate-with-instruction.mjs <slug> */
import { prisma } from "@pyre/db";
import { enqueueBuildJob } from "../dist/workers/scheduler.js";
const app = await prisma.app.findUnique({ where: { slug: process.argv[2] } });
const running = await prisma.buildJob.count({ where: { appId: app.id, status: { in: ["RUNNING", "QUEUED"] } } });
if (running) throw new Error("busy");
const id = await enqueueBuildJob({ app, stage: "ITERATE", budgetMicros: 25_000_000n, instruction: "Platform update: Pyre apps are free — there are no payments, checkout, subscriptions, ad slots or 'no ads' perks anymore; the SDK no longer exports Checkout, charge or AdSlot. Remove every reference to them (copy, perks lists, buttons, manifest products/adSlot/priceUsd). Holder perks stay via HolderGate. Then restyle the whole app to the platform design system that now ships in the template (read CLAUDE.md and src/index.css + src/components in the template copy at /home/user/template if present, else follow the documented tokens): obsidian background, ink text, tempered-violet primary, Instrument Serif display headings, Geist body, Geist Mono numbers, 8px cards with 1px borders, no orange/yellow/lime accents, no emoji. Keep all working features and tests green." });
console.log("queued", id); await prisma.$disconnect(); process.exit(0);
