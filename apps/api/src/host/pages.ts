import type { App } from "@pyre/db";
import { explorerTokenUrl, ponsUrl } from "@pyre/shared";
import { env } from "../env.js";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#e8e8ee;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:520px;padding:40px 28px;text-align:center}
img.logo{width:96px;height:96px;border-radius:24px;object-fit:cover;margin-bottom:20px;background:#1a1a22}
h1{font-size:28px;margin:0 0 8px}
p{margin:0 0 20px;color:#a0a0b0}
.ticker{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;padding:2px 8px;border-radius:999px;background:#1a1a22;color:#c8c8d8;margin-bottom:16px}
a.btn{display:inline-block;padding:12px 22px;border-radius:12px;background:#7c5cff;color:#fff;text-decoration:none;font-weight:600;margin:4px}
a.btn.alt{background:#1f1f2a;color:#e8e8ee}
.pulse{display:inline-block;width:10px;height:10px;border-radius:50%;background:#7c5cff;margin-right:8px;animation:p 1.2s infinite}
@keyframes p{0%,100%{opacity:.3}50%{opacity:1}}
small{display:block;margin-top:24px;color:#66667a;font-size:12px}
`;

const shell = (title: string, body: string, extraHead = ""): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${extraHead}<style>${CSS}</style></head><body><main>${body}</main></body></html>`;

const logo = (app: Pick<App, "imageUrl" | "name">): string =>
  app.imageUrl ? `<img class="logo" src="${escapeHtml(app.imageUrl)}" alt="${escapeHtml(app.name)}">` : "";

export function renderDormantPage(app: Pick<App, "name" | "ticker" | "slug" | "tokenAddress" | "imageUrl">): string {
  const coinPage = `${env.WEB_ORIGIN}/c/${app.slug}`;
  const token = app.tokenAddress;
  const buy = token
    ? `<a class="btn" href="${escapeHtml(ponsUrl(token))}" rel="noopener">Buy $${escapeHtml(app.ticker)} on PONS</a>`
    : "";
  const explorer = token
    ? `<a class="btn alt" href="${escapeHtml(explorerTokenUrl(token, env.BLOCKSCOUT_URL))}" rel="noopener">Blockscout</a>`
    : "";
  return shell(
    `${app.name} — out of budget`,
    `${logo(app)}<div class="ticker">$${escapeHtml(app.ticker)}</div><h1>${escapeHtml(app.name)} is out of budget</h1><p>This app is built and paid for by trading fees on its coin. The build budget hit zero, so the app is dormant. Buying revives it: new fees fund the next build.</p>${buy}<a class="btn alt" href="${escapeHtml(coinPage)}">Coin page</a>${explorer}<small>out of budget — buy to revive</small>`,
  );
}

export function renderKilledPage(app: Pick<App, "name" | "ticker" | "slug" | "imageUrl">): string {
  return shell(
    `${app.name} — removed`,
    `<h1>${escapeHtml(app.name)} has been removed</h1><p>This app was taken down by the platform and is no longer available.</p><a class="btn alt" href="${escapeHtml(`${env.WEB_ORIGIN}/c/${app.slug}`)}">Coin page</a>`,
  );
}

export function renderBuildingPage(app: Pick<App, "name" | "ticker" | "slug" | "imageUrl" | "status">): string {
  const coinPage = `${env.WEB_ORIGIN}/c/${app.slug}`;
  const copy: Record<string, string> = {
    FAILED: "The launch of this coin failed. Nothing is being built.",
    LIVE: "The agent is building the first version right now. This page refreshes on its own; watch the live build feed on the coin page.",
  };
  const text = copy[app.status] ?? "The coin is launching. Once trading fees reach the first build budget, the agent starts building.";
  const refresh = app.status === "FAILED" ? "" : `<meta http-equiv="refresh" content="15">`;
  return shell(
    `${app.name} — building`,
    `${logo(app)}<div class="ticker">$${escapeHtml(app.ticker)}</div><h1><span class="pulse"></span>${escapeHtml(app.name)} is being built</h1><p>${escapeHtml(text)}</p><a class="btn" href="${escapeHtml(coinPage)}">Watch the build</a>`,
    refresh,
  );
}

export function renderNotFoundPage(slug: string): string {
  return shell(
    "App not found",
    `<h1>No app here</h1><p>Nothing is deployed at <code>${escapeHtml(slug)}</code>.</p><a class="btn alt" href="${escapeHtml(env.WEB_ORIGIN)}">Browse apps</a>`,
  );
}
