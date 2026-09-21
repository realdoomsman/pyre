import { Router } from "express";
import { anthropicProxy } from "../proxy/anthropic.js";
import { auth } from "./auth.js";
import { proposals } from "./proposals.js";
import { admin } from "./admin.js";
import { apps } from "./apps.js";
import { bounties } from "./bounties.js";
import { governance } from "./governance.js";
import { launches } from "./launches.js";
import { me } from "./me.js";
import { notifications } from "./notifications.js";
import { publicRoutes } from "./public.js";
import { pyre } from "./pyre.js";
import { rpc } from "./rpc.js";
import { uploads } from "./uploads.js";
import { webhooks } from "./webhooks.js";

export const v1 = Router();

v1.use("/proxy/anthropic", anthropicProxy);
v1.use("/auth", auth);
v1.use("/proposals", proposals);
v1.use("/webhooks", webhooks);
v1.use("/admin", admin);
v1.use("/me/notifications", notifications);
v1.use("/me", me);
v1.use("/pyre", pyre);
v1.use("/rpc", rpc);
v1.use("/uploads", uploads);
// Routers with mixed prefixes (/apps/:slug/*, /queue/:id, /bounties/:id, /launches/*) mount at the root.
v1.use(launches);
v1.use(governance);
v1.use(bounties);
v1.use(publicRoutes);
v1.use("/apps", apps);
