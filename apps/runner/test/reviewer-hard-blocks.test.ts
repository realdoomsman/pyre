import { describe, expect, it } from "vitest";
import { hardBlockFindings } from "../src/build/reviewer.js";

/**
 * The mechanical blocker gates every deploy, so a false positive here is worse
 * than a missed nit: it silently rejects every build forever. That is exactly
 * what happened in production — the scanner matched the eslint config that BANS
 * these identifiers and the CLAUDE.md that documents them, so four consecutive
 * builds failed with "Blocked by platform policy: XMLHttpRequest, eval()".
 */
const diff = (file: string, ...lines: string[]): string =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...lines.map((l) => `+${l}`)].join("\n");

describe("hard blocks apply to shipping code", () => {
  it("blocks a raw fetch in app source", () => {
    const findings = hardBlockFindings(diff("src/App.tsx", "const r = await fetch('https://evil.example');"));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("BLOCK");
    expect(findings[0]?.text).toContain("src/App.tsx");
  });

  it("blocks an external script tag in the shell", () => {
    expect(hardBlockFindings(diff("index.html", '<script src="https://cdn.example/x.js"></script>'))).toHaveLength(1);
    expect(hardBlockFindings(diff("index.html", '<script src="//cdn.example/x.js"></script>'))).toHaveLength(1);
  });

  it("allows the local module script every Vite app boots from", () => {
    const shell = diff(
      "index.html",
      '<script type="module" src="/src/main.tsx"></script>',
      '<script type="module" src="./assets/index.js"></script>',
    );
    expect(hardBlockFindings(shell)).toEqual([]);
  });

  it("blocks key handling and transaction signing in a server function", () => {
    const findings = hardBlockFindings(
      diff("functions/pay.js", "const account = privateKeyToAccount(privateKey);", "await wallet.signTransaction(tx);"),
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it("blocks an injected browser wallet and typed-data signing in app source", () => {
    const findings = hardBlockFindings(
      diff("src/Pay.tsx", "await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });", "const sig = await signer.signTypedData(domain, types, msg);"),
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.map((f) => f.text).join("\n")).toContain("window.ethereum");
  });

  it("allows the SDK's own ship.fetch helper", () => {
    expect(hardBlockFindings(diff("src/App.tsx", "const data = await ship.fetch('/_pyre/fn/hello');"))).toEqual([]);
  });
});

describe("hard blocks ignore files that never reach a user", () => {
  it("does not block the eslint config that bans the identifiers", () => {
    const config = diff(
      "eslint.config.js",
      "no-restricted-globals: ['error', 'fetch', 'XMLHttpRequest', 'WebSocket'],",
      "'no-eval': 'error',",
    );
    expect(hardBlockFindings(config)).toEqual([]);
  });

  it("does not block CLAUDE.md documenting the rules", () => {
    const docs = diff(
      "CLAUDE.md",
      "Never call fetch(), XMLHttpRequest, WebSocket or eval() — use ship.fn instead.",
      "Never add an external <script src=...> tag.",
    );
    expect(hardBlockFindings(docs)).toEqual([]);
  });

  it("does not block Playwright tests or local dev tooling", () => {
    expect(hardBlockFindings(diff("tests/smoke.spec.ts", "await page.evaluate(() => eval('1+1'));"))).toEqual([]);
    expect(hardBlockFindings(diff("dev/pyre-local-host.ts", "const x = new XMLHttpRequest();"))).toEqual([]);
  });

  it("does not block vendored SDK or lockfile churn", () => {
    expect(hardBlockFindings(diff("app-sdk/dist/index.js", "new XMLHttpRequest()"))).toEqual([]);
    expect(hardBlockFindings(diff("package-lock.json", '"integrity": "sha512-eval("'))).toEqual([]);
  });
});
