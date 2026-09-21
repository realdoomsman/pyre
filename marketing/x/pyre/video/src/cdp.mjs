// Minimal headless-Chrome CDP client (no deps). One Chrome, one page, one
// WebSocket. Used by capture.mjs (live site) and render.mjs (scene frames).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width, height, scale = 1 }) {
  const profile = mkdtempSync(join(tmpdir(), "pyre-video-"));
  const port = 9400 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      `--force-device-scale-factor=${scale}`,
      "--font-render-hinting=none",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let targets;
  for (let i = 0; i < 80; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (targets.length) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  if (!targets?.length) throw new Error("chrome did not come up");
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`)) : resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      logs.push(`[exception] ${(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 600)}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      logs.push(`[console.error] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400)}`);
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };
  const send = (method, params = {}) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    return promise;
  };
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false, screenWidth: width, screenHeight: height });

  /** Evaluate an expression; awaits promises; throws on page exceptions. */
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  /** Navigate and wait for the load event (plus optional settle time). */
  const goto = async (url, settleMs = 0) => {
    const loaded = new Promise((res) => on("Page.loadEventFired", res));
    await send("Page.navigate", { url });
    await loaded;
    if (settleMs) await sleep(settleMs);
  };

  const screenshot = async (format = "png", quality) =>
    Buffer.from((await send("Page.captureScreenshot", { format, quality, captureBeyondViewport: false, optimizeForSpeed: true })).data, "base64");

  const close = () => {
    try { ws.close(); } catch { /* already gone */ }
    chrome.kill();
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ } }, 500);
  };

  return { send, on, evaluate, goto, screenshot, close, logs };
}
