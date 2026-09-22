/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { chromium, type Browser, type Page } from "playwright";
import { isAddress, getAddress, type Address } from "viem";

/*
 * Zentro deposit-address minting. Zentro has no API and rotates the deposit address per top-up, so
 * the only way to obtain one is to drive a logged-in zentro.finance session in a real browser. The
 * session + CardHub keys are supplied as ZENTRO_STATE (captured once from an authenticated browser);
 * nothing here is logged. This is deliberately isolated so the sensitive state lives in exactly one
 * place. See the credit-funding flow in workers/chain/credits.ts.
 */

/** Zentro's per-top-up minimum (whole dollars). */
export const ZENTRO_MIN_TOPUP_USD = 15;
/** Thrown (as `Error.message`) when the stored session no longer authenticates. */
export const ZENTRO_SESSION_EXPIRED = "zentro_session_expired";

interface ZentroCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
}
export interface ZentroState {
  cookies: ZentroCookie[];
  localStorage: Record<string, string>;
}

export const parseZentroState = (raw: string): ZentroState => {
  const s = JSON.parse(raw) as ZentroState;
  if (!Array.isArray(s.cookies) || typeof s.localStorage !== "object" || s.localStorage === null) {
    throw new Error("ZENTRO_STATE malformed: expected { cookies:[], localStorage:{} }");
  }
  return s;
};

/** `0x1234…abcd` — the only form a deposit address may take in logs, alerts and audit rows. */
export const maskAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const DASH_URL = "https://zentro.finance/dash";
const API = "/dash/api/v1/";
/** The dashboard sometimes boots without its card or 500s on `target`; each attempt reloads and re-walks. */
const ATTEMPTS = 4;

const looksLoggedOut = async (page: Page): Promise<boolean> =>
  /\/(login|signin|auth)/i.test(page.url()) ||
  (await page.evaluate(() => {
    const t = document.body?.innerText ?? "";
    return !/log ?out/i.test(t) && /(log|sign) ?in|password/i.test(t);
  }));

/**
 * Loads the dashboard and waits (best effort) for the card itself to load (`GET item?cardId=` 200):
 * before that the Top Up flow tends to open on a half-initialised session and 500 on `target`.
 * The app sometimes boots without ever fetching the card; the caller's re-walk covers that.
 */
const openDashboard = async (page: Page): Promise<void> => {
  const ready = page.waitForResponse((r) => r.url().includes(`${API}item?cardId=`) && r.ok(), { timeout: 20_000 }).then(
    () => true,
    () => false,
  );
  if (page.url().startsWith(DASH_URL)) await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
  else await page.goto(DASH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (await ready) return;
  if (await looksLoggedOut(page)) throw new Error(ZENTRO_SESSION_EXPIRED);
};

export interface ZentroDeposit {
  /** Checksummed Ethereum-mainnet address that credits the card when it receives USDC. */
  address: Address;
  /** Whole dollars Zentro expects at that address. */
  amountUsd: number;
}

/**
 * Walks Top Up → USDC (Ethereum) → amount → Continue. `Continue` first calls `GET target` (which
 * the site itself sometimes answers 500 on the first try, leaving the modal wedged — reload and
 * re-walk), then `POST transfer` and `GET transfer/bridge-*`, after which `#deposit-send-address`
 * holds the address.
 */
const mintAddress = async (page: Page, amount: number): Promise<string> => {
  for (let attempt = 1; ; attempt++) {
    await openDashboard(page);
    await page.getByText(/^top ?up$/i).first().click({ timeout: 10_000 });
    await page.getByText(/USDC \(Ethereum\)/i).first().click({ timeout: 10_000 });
    await page.locator("input#deposit-amount").fill(String(amount), { timeout: 10_000 });
    const target = page.waitForResponse((r) => r.url().includes(`${API}target`), { timeout: 20_000 }).then(
      (r) => r.status(),
      () => 0,
    );
    await page.getByText(/^continue$/i).first().click({ timeout: 10_000 });
    if ((await target) === 200) break;
    if (attempt >= ATTEMPTS) throw new Error("zentro_flow: top-up target request kept failing");
  }
  const el = page.locator("#deposit-send-address");
  await el.filter({ hasText: /0x[0-9a-fA-F]{40}/ }).waitFor({ timeout: 30_000 });
  return (await el.textContent())?.trim() ?? "";
};

/**
 * Mints a fresh USDC-on-Ethereum deposit address for `amountUsd` (whole dollars, floored to
 * ≥ ZENTRO_MIN_TOPUP_USD). Throws `zentro_session_expired` when the stored session no longer
 * authenticates, so the caller can alert an operator to re-capture it.
 */
export async function getZentroDepositAddress(rawState: string, amountUsd: number): Promise<ZentroDeposit> {
  const state = parseZentroState(rawState);
  const amount = Math.max(ZENTRO_MIN_TOPUP_USD, Math.floor(amountUsd));
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" });
    await ctx.addCookies(
      state.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: (c.domain ?? "zentro.finance").replace(/^\./, ""),
        path: c.path ?? "/",
        httpOnly: c.httpOnly ?? true,
        secure: true,
        sameSite: "Lax" as const,
      })),
    );
    await ctx.addInitScript((ls: Record<string, string>) => {
      try {
        for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
      } catch {
        /* localStorage unavailable before navigation on some origins */
      }
    }, state.localStorage);

    const page = await ctx.newPage();
    const address = await mintAddress(page, amount);
    if (!isAddress(address, { strict: false })) throw new Error("zentro_flow: extracted address is not an Ethereum address");
    return { address: getAddress(address), amountUsd: amount };
  } finally {
    await browser?.close();
  }
}
