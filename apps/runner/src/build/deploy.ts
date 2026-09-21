import { createHash } from "node:crypto";
import { extname } from "node:path";
import { prisma } from "@pyre/db";
import { PyreManifest } from "@pyre/shared";
import type { Sandbox } from "e2b";
import { appLiveUrl } from "../env.js";
import { APP_DIR, RUNNER_DIR, readBytes, run } from "../sandbox/sandbox.js";
import { extractTgz } from "../sandbox/tar.js";
import type { Screenshot } from "./verify.js";

export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

/** Thrown when the bundle cannot be deployed for reasons the reviewer should have caught (policy-level). */
export class BundleError extends Error {}

export type DeployResult = { deploymentId: string; version: number; url: string; manifest: PyreManifest };

/**
 * Tar `dist/ functions/ pyre.manifest.json` inside the sandbox, validate the
 * manifest, and persist Deployment + DeployFile rows (plus screenshots under
 * `_pyre/screenshots/`). Bumps `App.liveVersion` and sets `mvpLiveAt` on first deploy.
 */
export const createDeployment = async (opts: {
  sbx: Sandbox;
  appId: string;
  slug: string;
  commitSha: string | null;
  screenshots: Screenshot[];
}): Promise<DeployResult> => {
  const bundlePath = `${RUNNER_DIR}/bundle.tgz`;
  const packed = await run(
    opts.sbx,
    `[ -d dist ] || { echo "no dist/ directory"; exit 2; }; [ -f pyre.manifest.json ] || { echo "no pyre.manifest.json"; exit 2; }; tar czf ${bundlePath} dist pyre.manifest.json $([ -d functions ] && echo functions)`,
    { cwd: APP_DIR, timeoutMs: 120_000 },
  );
  if (packed.exitCode !== 0) throw new BundleError(`bundle failed: ${(packed.stdout + packed.stderr).trim().slice(0, 500)}`);
  const bundle = await readBytes(opts.sbx, bundlePath);
  if (bundle.length > MAX_BUNDLE_BYTES) throw new BundleError(`bundle is ${bundle.length} bytes, cap is ${MAX_BUNDLE_BYTES}`);

  let entries;
  try {
    entries = await extractTgz(bundle, MAX_BUNDLE_BYTES);
  } catch (e) {
    throw new BundleError(`bundle unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const manifestEntry = entries.find((e) => e.path === "pyre.manifest.json");
  if (!manifestEntry) throw new BundleError("pyre.manifest.json missing from bundle");
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(new TextDecoder().decode(manifestEntry.body));
  } catch {
    throw new BundleError("pyre.manifest.json is not valid JSON");
  }
  const manifestParsed = PyreManifest.safeParse(manifestRaw);
  if (!manifestParsed.success) {
    throw new BundleError(
      `pyre.manifest.json invalid: ${manifestParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const manifest = manifestParsed.data;
  const declaredFns: Record<string, true> = {};
  for (const f of manifest.functions) declaredFns[f.name] = true;
  for (const e of entries) {
    const m = /^functions\/([^/]+)\.js$/.exec(e.path);
    if (m && m[1] && !declaredFns[m[1]]) {
      throw new BundleError(`functions/${m[1]}.js exists but is not declared in pyre.manifest.json`);
    }
  }
  if (!entries.some((e) => e.path === `dist/${manifest.entry}`)) {
    throw new BundleError(`manifest entry dist/${manifest.entry} not found in build output`);
  }

  const files = entries.map((e) => {
    const path = e.path.startsWith("dist/") ? e.path.slice(5) : e.path;
    return {
      path,
      contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      body: e.body,
      size: e.body.length,
    };
  });
  for (const s of opts.screenshots) {
    files.push({ path: `_pyre/screenshots/${s.label}.png`, contentType: "image/png", body: s.png, size: s.png.length });
  }

  const bundleSha = createHash("sha256").update(bundle).digest("hex");
  const url = appLiveUrl(opts.slug);
  const result = await prisma.$transaction(async (tx) => {
    const last = await tx.deployment.aggregate({ where: { appId: opts.appId }, _max: { version: true } });
    const version = (last._max.version ?? 0) + 1;
    const deployment = await tx.deployment.create({
      data: {
        appId: opts.appId,
        version,
        manifest,
        bundle,
        bundleSha,
        sizeBytes: bundle.length,
        commitSha: opts.commitSha,
      },
    });
    await tx.deployFile.createMany({
      data: files.map((f) => ({ deploymentId: deployment.id, ...f })),
    });
    const app = await tx.app.findUniqueOrThrow({ where: { id: opts.appId }, select: { mvpLiveAt: true } });
    await tx.app.update({
      where: { id: opts.appId },
      data: { liveVersion: version, mvpLiveAt: app.mvpLiveAt ?? new Date(), healthy: true, consecutiveFails: 0 },
    });
    return { deploymentId: deployment.id, version };
  });
  return { ...result, url, manifest };
};
