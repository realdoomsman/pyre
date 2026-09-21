import { describe, expect, it, vi } from "vitest";
import type { HostApi } from "../src/host/quickjs.js";

/**
 * The QuickJS boundary. These run the real `host/quickjs.ts` runtime (wasm, no network) and the
 * real `host/routes/kv.ts` against an in-memory prisma double, because the guarantee under test is
 * exactly the one a malicious deployed function attacks: no host globals, no filesystem, a deadline
 * it cannot outrun, and a memory abort that does not poison the next tenant's call.
 *
 * Deadline tests use real timers on purpose: `runFunction` measures CPU and wall budgets against
 * `Date.now()` and an interrupt handler inside wasm, which fake timers cannot drive.
 */

interface KvRow {
  appId: string;
  scope: string;
  key: string;
  value: unknown;
}

/** Runtime insertion/deletion keyed by a composite string; four call sites need it in lockstep. */
const kvRows = new Map<string, KvRow>();
const rowKey = (w: { appId: string; scope: string; key: string }): string => `${w.appId}\u0000${w.scope}\u0000${w.key}`;

vi.mock("@pyre/db", () => ({
  Prisma: { JsonNull: { __jsonNull: true } },
  prisma: {
    appKv: {
      findUnique: async ({ where }: { where: { appId_scope_key: KvRow } }) => kvRows.get(rowKey(where.appId_scope_key)) ?? null,
      upsert: async ({ where, create }: { where: { appId_scope_key: KvRow }; create: KvRow }) => {
        kvRows.set(rowKey(where.appId_scope_key), { ...create });
        return create;
      },
      deleteMany: async ({ where }: { where: { appId: string; scope: string; key: string } }) => ({
        count: kvRows.delete(rowKey(where)) ? 1 : 0,
      }),
    },
  },
}));

import { HttpError } from "../src/lib/errors.js";
import { runFunction, scheduleFunction, serializeResult } from "../src/host/quickjs.js";
import { APP_SCOPE, kvDelete, kvRead, kvWrite } from "../src/host/routes/kv.js";

const APP_ID = "app_test";

const run = (
  source: string,
  opts: { input?: unknown; api?: HostApi; cpuMs?: number; wallMs?: number; memoryBytes?: number } = {},
): Promise<unknown> =>
  runFunction({
    source,
    filename: "test.js",
    input: opts.input ?? {},
    api: opts.api ?? {},
    cpuMs: opts.cpuMs ?? 1_000,
    wallMs: opts.wallMs ?? 3_000,
    memoryBytes: opts.memoryBytes ?? 32 * 1024 * 1024,
  });

/** The `ship.kv` surface `fn.ts` hands to guests, wired to the real kv module. */
const kvApi = (): HostApi => ({
  kv: {
    get: async (key: unknown) => kvRead(APP_ID, APP_SCOPE, String(key)),
    set: async (key: unknown, value: unknown) => {
      await kvWrite(APP_ID, APP_SCOPE, String(key), value);
      return true;
    },
    del: async (key: unknown) => kvDelete(APP_ID, APP_SCOPE, String(key)),
  },
});

/** Host call that settles after `ms` of real time, mimicking a slow database or RPC round trip. */
const slowHostCall = (ms: number, value: unknown): HostApi => ({
  slow: async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    setTimeout(() => resolve(value), ms);
    return promise;
  },
});

describe("guest isolation", () => {
  it("reaches no host globals", async () => {
    const result = await run(`export default async function handler() {
      return {
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        globalProcess: typeof globalThis.process,
        module: typeof module,
        Buffer: typeof Buffer,
        __dirname: typeof __dirname,
        eval: typeof eval,
        WebAssembly: typeof WebAssembly,
        XMLHttpRequest: typeof XMLHttpRequest,
      };
    }`);
    expect(result).toEqual({
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      globalProcess: "undefined",
      module: "undefined",
      Buffer: "undefined",
      __dirname: "undefined",
      eval: "function",
      WebAssembly: "undefined",
      XMLHttpRequest: "undefined",
    });
  });

  it("cannot reach a host runtime through any named global", async () => {
    const result = await run(`export default async function handler() {
      const probes = ["process", "require", "Deno", "Bun", "global", "globalThis.process"];
      const reachable = [];
      for (const p of probes) {
        try { if (eval(p) !== undefined) reachable.push(p); } catch { /* ReferenceError is the point */ }
      }
      return { reachable, injected: Object.getOwnPropertyNames(globalThis).filter((k) => k.startsWith("__")).sort() };
    }`);
    // Only the three host bridges exist (input, api, result promise); nothing named after a host
    // runtime is reachable.
    expect(result).toEqual({ reachable: [], injected: ["__input", "__pyre", "__result"] });
  });

  it("cannot forge a completed call by overwriting the result bridge with a non-promise", async () => {
    // The host treats a non-promise `__result` as "module body still running", so a guest that
    // clobbers it never gets a fabricated 200 — it gets the never-settled failure instead.
    await expect(
      run(`export default async function handler() { globalThis.__result = { forged: true }; return new Promise(() => {}); }`),
    ).rejects.toThrow(/never settled/);
  });

  it("cannot import anything, including node builtins and relative files", async () => {
    for (const specifier of ["node:fs", "fs", "node:child_process", "./secrets.js", "/etc/passwd", "https://evil.test/x.js"]) {
      await expect(
        run(`import * as m from "${specifier}";\nexport default async function handler() { return m; }`),
      ).rejects.toThrow(/imports are not available/);
    }
  });

  it("cannot touch the filesystem via dynamic import either", async () => {
    // Intentional runtime import inside the guest: the boundary under test is module loading.
    await expect(run(`export default async function handler() { await import("node:fs"); return "read"; }`)).rejects.toThrow(
      /imports are not available/,
    );
  });

  it("only sees the host functions it was given", async () => {
    const api: HostApi = { user: { id: "u1", wallet: null, isHolder: false }, echo: async (v: unknown) => v };
    const result = await run(
      `export default async function handler(input, ship) {
         return { keys: Object.keys(ship).sort(), echoed: await ship.echo(input.n), user: ship.user.id };
       }`,
      { input: { n: 7 }, api },
    );
    expect(result).toEqual({ keys: ["echo", "user"], echoed: 7, user: "u1" });
  });

  it("surfaces a host function rejection as a guest-catchable error, not a host crash", async () => {
    const api: HostApi = {
      boom: async () => {
        throw new Error("upstream refused");
      },
    };
    const result = await run(
      `export default async function handler(input, ship) {
         try { await ship.boom(); return "no-throw"; } catch (e) { return e.message; }
       }`,
      { api },
    );
    expect(result).toBe("upstream refused");
  });
});

describe("deadlines", () => {
  it("interrupts a tight infinite loop with a 504 instead of hanging", async () => {
    const started = Date.now();
    await expect(run(`export default async function handler() { for (;;) {} }`, { cpuMs: 300, wallMs: 5_000 })).rejects.toMatchObject({
      status: 504,
    });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("interrupts an infinite loop inside a promise chain", async () => {
    await expect(
      run(`export default async function handler() { await null; while (true) { Math.sqrt(2); } }`, { cpuMs: 300, wallMs: 5_000 }),
    ).rejects.toMatchObject({ status: 504 });
  });

  it("enforces the wall deadline when the guest is parked on a slow host call", async () => {
    const started = Date.now();
    await expect(
      run(`export default async function handler(i, ship) { return ship.slow(); }`, { api: slowHostCall(2_000, "late"), wallMs: 300 }),
    ).rejects.toMatchObject({ status: 504 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1_800);
  });

  it("rejects a handler that never settles rather than waiting out the deadline", async () => {
    await expect(
      run(`export default async function handler() { return new Promise(() => {}); }`, { wallMs: 5_000 }),
    ).rejects.toThrow(/never settled/);
  });

  it("charges only guest execution against the CPU budget, so slow host calls do not trip it", async () => {
    const result = await run(`export default async function handler(i, ship) { return ship.slow(); }`, {
      api: slowHostCall(600, 42),
      cpuMs: 200,
      wallMs: 5_000,
    });
    expect(result).toBe(42);
  });
});

describe("memory limits", () => {
  it("fails an over-limit allocation and still serves the next call correctly", async () => {
    await expect(
      run(`export default async function handler() { const a = []; for (;;) a.push(new Array(100000).fill("x")); }`, {
        memoryBytes: 2 * 1024 * 1024,
        cpuMs: 5_000,
        wallMs: 10_000,
      }),
    ).rejects.toMatchObject({ status: 500 });

    // The shared wasm module is replaced after an OOM abort; the very next tenant must be unaffected.
    expect(await run(`export default async function handler() { return "next tenant ok"; }`)).toBe("next tenant ok");
    expect(await run(`export default async function handler(input) { return input.a + input.b; }`, { input: { a: 2, b: 3 } })).toBe(5);
  });

  it("recovers from a guest stack overflow without poisoning the runtime", async () => {
    await expect(run(`export default async function handler() { const f = () => f(); return f(); }`)).rejects.toBeInstanceOf(HttpError);
    expect(await run(`export default async function handler() { return "still alive"; }`)).toBe("still alive");
  });
});

describe("results", () => {
  it("returns JSON values and maps undefined to null", async () => {
    expect(await run(`export default async function handler() { return { a: [1, "two", null], b: true }; }`)).toEqual({
      a: [1, "two", null],
      b: true,
    });
    expect(await run(`export default async function handler() {}`)).toBeNull();
  });

  it("rejects a non-function default export", async () => {
    await expect(run(`export default 42;`)).rejects.toThrow(/must export default a function/);
  });

  it("refuses an oversized serialized result", () => {
    expect(serializeResult({ ok: true })).toBe('{"ok":true}');
    expect(serializeResult(undefined)).toBe("null");
    expect(() => serializeResult({ blob: "x".repeat(1024 * 1024 + 1) })).toThrow(/result too large/);
  });
});

describe("scheduleFunction", () => {
  it("caps per-app concurrency at 4 while still letting every call through", async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    const work = async (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      // Real timer: the limiter's release path is driven by promise settlement, not the clock.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 15);
      await promise;
      active--;
      completed++;
    };
    await Promise.all(Array.from({ length: 12 }, () => scheduleFunction("app_concurrency", work)));
    expect(peak).toBe(4);
    expect(completed).toBe(12);
  });

  it("releases its slot when the work throws, so a failing function cannot wedge the app", async () => {
    for (let i = 0; i < 6; i++) {
      await expect(
        scheduleFunction("app_failures", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    }
    expect(await scheduleFunction("app_failures", async () => "ok")).toBe("ok");
  });
});

describe("ship.kv from inside the sandbox", () => {
  it("round-trips values through the host bridge", async () => {
    const result = await run(
      `export default async function handler(input, ship) {
         await ship.kv.set("counter:1", { n: 1 });
         const read = await ship.kv.get("counter:1");
         const missing = await ship.kv.get("counter:absent");
         const deleted = await ship.kv.del("counter:1");
         return { read, missing, deleted, afterDelete: await ship.kv.get("counter:1") };
       }`,
      { api: kvApi() },
    );
    expect(result).toEqual({ read: { n: 1 }, missing: null, deleted: true, afterDelete: null });
  });

  it("enforces the key pattern inside the guest, not at the HTTP edge", async () => {
    const result = await run(
      `export default async function handler(input, ship) {
         const out = {};
         for (const key of input.keys) {
           try { await ship.kv.set(key, 1); out[key] = "accepted"; }
           catch (e) { out[key] = e.message.slice(0, 11); }
         }
         return out;
       }`,
      { api: kvApi(), input: { keys: ["ok.key:1-2_3", "", "has space", "unicod\u00e9", "a/b", "x".repeat(121), "x".repeat(120)] } },
    );
    expect(result).toEqual({
      "ok.key:1-2_3": "accepted",
      "": "invalid key",
      "has space": "invalid key",
      "unicod\u00e9": "invalid key",
      "a/b": "invalid key",
      ["x".repeat(121)]: "invalid key",
      ["x".repeat(120)]: "accepted",
    });
  });

  it("rejects an over-cap value and stores nothing", async () => {
    const result = await run(
      `export default async function handler(input, ship) {
         const big = "x".repeat(input.size);
         try { await ship.kv.set("big", big); return { stored: true }; }
         catch (e) { return { stored: false, message: e.message, readBack: await ship.kv.get("big") }; }
       }`,
      { api: kvApi(), input: { size: 64 * 1024 } },
    );
    expect(result).toEqual({ stored: false, message: "value exceeds 64KB", readBack: null });
  });

  it("accepts a value whose JSON encoding fits exactly inside the 64KB cap", async () => {
    // The two JSON quotes count against the cap, so 65_534 payload chars is the last accepted size.
    const result = await run(
      `export default async function handler(input, ship) {
         await ship.kv.set("edge", "y".repeat(input.size));
         const value = await ship.kv.get("edge");
         return { length: value.length };
       }`,
      { api: kvApi(), input: { size: 64 * 1024 - 2 } },
    );
    expect(result).toEqual({ length: 64 * 1024 - 2 });
  });

  it("rejects values that are not JSON-serializable and keeps null distinct from missing", async () => {
    await expect(kvWrite(APP_ID, APP_SCOPE, "undef", undefined)).rejects.toThrow(/value is required/);
    await expect(kvWrite(APP_ID, APP_SCOPE, "fn", () => 1)).rejects.toThrow(/JSON-serializable/);
    await kvWrite(APP_ID, APP_SCOPE, "explicit-null", null);
    expect(kvRows.get(rowKey({ appId: APP_ID, scope: APP_SCOPE, key: "explicit-null" }))?.value).toEqual({ __jsonNull: true });
    expect(await kvDelete(APP_ID, APP_SCOPE, "never-existed")).toBe(false);
  });

  it("scopes keys per app, so one app cannot read another's value", async () => {
    await kvWrite("app_a", APP_SCOPE, "shared", { owner: "a" });
    await kvWrite("app_b", APP_SCOPE, "shared", { owner: "b" });
    expect(await kvRead("app_a", APP_SCOPE, "shared")).toEqual({ owner: "a" });
    expect(await kvRead("app_b", APP_SCOPE, "shared")).toEqual({ owner: "b" });
    expect(await kvRead("app_c", APP_SCOPE, "shared")).toBeNull();
    // The user scope is a different namespace from the shared app scope for the same key.
    await kvWrite("app_a", "user:u1", "shared", { owner: "u1" });
    expect(await kvRead("app_a", APP_SCOPE, "shared")).toEqual({ owner: "a" });
  });
});
