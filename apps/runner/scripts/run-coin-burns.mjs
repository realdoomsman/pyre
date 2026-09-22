#!/usr/bin/env node
/** Runs one coin-burn pass now (what the buyback scan does every 10 minutes). */
import pino from "pino";
import { prisma } from "@pyre/db";
import { runCoinBurns } from "../dist/workers/chain/coinBurn.js";
await runCoinBurns(pino({ level: "debug" }));
await prisma.$disconnect();
process.exit(0);
