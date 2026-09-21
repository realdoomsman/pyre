import { Router } from "express";
import { dec, Prisma, prisma } from "@pyre/db";
import { ApproveSpecBody, CreateLaunchBody, StakeBody } from "@pyre/shared";
import { requireAuth } from "../lib/auth.js";
import { launchDto } from "../lib/dto.js";
import { HttpError, parse, wrap } from "../lib/errors.js";
import { publishEvent } from "../lib/events.js";
import { createLaunch, settleStake } from "../lib/launch.js";
import { queues } from "../lib/queues.js";
import { TREASURY_WALLET } from "../lib/treasury.js";
import { env } from "../env.js";

export const launches = Router();

launches.post(
  "/launches",
  requireAuth,
  wrap(async (req, res) => {
    const body = parse(CreateLaunchBody, req.body);
    let forkOf = null;
    if (body.forkOfAppId) {
      forkOf = await prisma.app.findUnique({ where: { id: body.forkOfAppId } });
      if (!forkOf) throw new HttpError(404, "fork_parent_not_found");
      if (forkOf.status !== "LIVE") throw new HttpError(409, "fork_parent_not_live");
    }
    const app = await createLaunch(req.user!, body, forkOf);
    res.status(201).json({ launch: launchDto(app) });
  }),
);

/** Fork an existing LIVE app: same flow as a launch, prompt prefilled with the parent's spec. */
launches.post(
  "/apps/:slug/fork",
  requireAuth,
  wrap(async (req, res) => {
    const parent = await prisma.app.findUnique({ where: { slug: req.params.slug! } });
    if (!parent) throw new HttpError(404, "app_not_found");
    if (parent.status !== "LIVE") throw new HttpError(409, "fork_parent_not_live");
    const body = parse(
      CreateLaunchBody.omit({ forkOfAppId: true }).extend({ prompt: CreateLaunchBody.shape.prompt.default("Keep the original scope; improve quality and polish.") }),
      req.body,
    );
    const app = await createLaunch(req.user!, { ...body, forkOfAppId: parent.id }, parent);
    res.status(201).json({ launch: launchDto(app) });
  }),
);

const ownedLaunch = async (id: string, userId: string, isAdmin: boolean) => {
  const app = await prisma.app.findUnique({ where: { id } });
  if (!app) throw new HttpError(404, "launch_not_found");
  if (app.launcherId !== userId && !isAdmin) throw new HttpError(403, "forbidden");
  return app;
};

launches.get(
  "/launches/:id",
  requireAuth,
  wrap(async (req, res) => {
    const app = await ownedLaunch(req.params.id!, req.user!.id, req.user!.isAdmin);
    res.json({ launch: launchDto(app) });
  }),
);

/** Approves the generated spec; the launch now waits for the refundable ETH stake. */
launches.post(
  "/launches/:id/approve",
  requireAuth,
  wrap(async (req, res) => {
    const app = await ownedLaunch(req.params.id!, req.user!.id, req.user!.isAdmin);
    if (app.status !== "SPEC_READY") throw new HttpError(409, "spec_not_ready", { status: app.status });
    const { spec } = parse(ApproveSpecBody, req.body);
    const updated = await prisma.app.update({
      where: { id: app.id },
      data: { spec, template: spec.template, specApprovedAt: new Date(), status: "AWAITING_STAKE" },
    });
    res.json({ launch: launchDto(updated), stake: { to: TREASURY_WALLET, wei: env.LAUNCH_STAKE_WEI.toString() } });
  }),
);

/**
 * Settles the stake — `{txHash}` from an external wallet (verified on chain) or `{custodial:true}`
 * (server-signed from the launcher's Pyre wallet) — then hands the app to the launch worker.
 */
launches.post(
  "/launches/:id/stake",
  requireAuth,
  wrap(async (req, res) => {
    const app = await ownedLaunch(req.params.id!, req.user!.id, req.user!.isAdmin);
    if (app.status !== "AWAITING_STAKE") throw new HttpError(409, "not_awaiting_stake", { status: app.status });
    if (!app.walletAddress) throw new HttpError(409, "app_has_no_wallet");
    const body = parse(StakeBody, req.body);
    const stake = await settleStake(app, req.user!, body);
    // The status guard makes this a compare-and-set: a second submit after the first settled is a 409, never a double stake.
    // `stakeTx` is unique, so two launches racing to claim the same external transfer cannot both win.
    let settled: { count: number };
    try {
      settled = await prisma.app.updateMany({
        where: { id: app.id, status: "AWAITING_STAKE" },
        data: { stakeTx: stake.txHash, stakeWei: dec(stake.wei), status: "LAUNCHING" },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new HttpError(409, "stake_tx_already_used");
      throw err;
    }
    if (settled.count === 0) throw new HttpError(409, "not_awaiting_stake", { status: "LAUNCHING" });
    await queues.launch.add("launch", { appId: app.id }, { jobId: `launch-${app.id}` });
    await publishEvent(app.id, { type: "STAGE", stage: "LAUNCH", status: "START" });
    const updated = await prisma.app.findUniqueOrThrow({ where: { id: app.id } });
    res.json({ launch: launchDto(updated) });
  }),
);
