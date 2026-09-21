import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  RELEASE_SYNC,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export type HostFunction = (...args: unknown[]) => Promise<unknown>;
/** Tree of JSON values and host functions exposed to the guest as the `ship` object. */
export interface HostApi {
  [key: string]: unknown | HostFunction | HostApi;
}

export interface RunOptions {
  /** ESM source with `export default async function handler(input, ship)`. */
  source: string;
  filename: string;
  input: unknown;
  api: HostApi;
  /** VM execution budget (interrupt handler). */
  cpuMs: number;
  /** Total budget including awaited host calls. */
  wallMs: number;
  memoryBytes: number;
}

const MAX_RESULT_BYTES = 1024 * 1024;
const STACK_BYTES = 256 * 1024;
const MODULE_NAME = "ship:function";

/**
 * Ceiling on the wasm linear memory of one QuickJS module (every concurrent runtime shares it).
 * `runtime.setMemoryLimit` is not a real bound in the emscripten build — its accounting sees only
 * the 8-byte block overhead (`dumpMemoryUsage` reports ~8 bytes "allocated" per multi-MB array), so
 * a runaway guest is stopped only when the heap itself can no longer grow. Without this cap that
 * is the wasm32 maximum (2 GB) per fault. A wasm heap never shrinks, so a module whose heap has
 * been blown is replaced after the call (see `runFunction`).
 */
const WASM_HEAP_MAX_BYTES = 256 * 1024 * 1024;
const WASM_HEAP_INITIAL_BYTES = 16 * 1024 * 1024;
const WASM_PAGE_BYTES = 65_536;

const require = createRequire(import.meta.url);

/** The wasm binary is compiled once per process; replacing a module only re-instantiates it. */
let compiledWasm: Promise<WebAssembly.Module> | null = null;
const compileWasm = (): Promise<WebAssembly.Module> =>
  (compiledWasm ??= readFile(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")).then((bytes) => WebAssembly.compile(bytes)));

let modulePromise: Promise<QuickJSWASMModule> | null = null;
const loadModule = (): Promise<QuickJSWASMModule> =>
  (modulePromise ??= newQuickJSWASMModuleFromVariant(
    newVariant(RELEASE_SYNC, {
      wasmModule: compileWasm,
      wasmMemory: async () => new WebAssembly.Memory({ initial: WASM_HEAP_INITIAL_BYTES / WASM_PAGE_BYTES, maximum: WASM_HEAP_MAX_BYTES / WASM_PAGE_BYTES }),
    }),
  ));

function injectJson(vm: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === undefined) return vm.undefined;
  if (value === null) return vm.null;
  if (typeof value === "string") return vm.newString(value);
  if (typeof value === "number") return vm.newNumber(value);
  if (typeof value === "boolean") return value ? vm.true : vm.false;
  const text = JSON.stringify(value);
  if (text === undefined) return vm.undefined;
  return vm.unwrapResult(vm.evalCode(`(${text})`, "host-json.js"));
}

/** Static singleton handles (undefined/null/true/false) must not be disposed. */
function disposeValue(vm: QuickJSContext, h: QuickJSHandle): void {
  if (h !== vm.undefined && h !== vm.null && h !== vm.true && h !== vm.false) h.dispose();
}

function guestErrorMessage(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle) as unknown;
  if (dumped && typeof dumped === "object") {
    const { name, message } = dumped as { name?: unknown; message?: unknown };
    const text = [name, message].filter((v) => typeof v === "string" && v.length > 0).join(": ");
    return text.slice(0, 500) || "error";
  }
  return String(dumped).slice(0, 500);
}

interface Session {
  vm: QuickJSContext;
  deferreds: Set<QuickJSDeferredPromise>;
  inflight: number;
  wake: () => void;
}

function buildApi(session: Session, node: HostApi | unknown): QuickJSHandle {
  const { vm } = session;
  if (typeof node === "function") {
    const fn = node as HostFunction;
    return vm.newFunction("hostfn", (...argHandles) => {
      const args = argHandles.map((h) => vm.dump(h) as unknown);
      const deferred = vm.newPromise();
      session.deferreds.add(deferred);
      session.inflight++;
      fn(...args)
        .then(
          (value) => {
            if (!deferred.alive) return;
            const h = injectJson(vm, value);
            deferred.resolve(h);
            disposeValue(vm, h);
          },
          (err: unknown) => {
            if (!deferred.alive) return;
            const message = err instanceof Error ? err.message : String(err);
            const h = vm.newError(message.slice(0, 500));
            deferred.reject(h);
            h.dispose();
          },
        )
        .finally(() => {
          session.inflight--;
          if (deferred.alive) {
            session.deferreds.delete(deferred);
            deferred.dispose();
          }
          session.wake();
        });
      return deferred.handle;
    });
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const obj = vm.newObject();
    for (const [key, value] of Object.entries(node as HostApi)) {
      const h = buildApi(session, value);
      vm.setProp(obj, key, h);
      disposeValue(vm, h);
    }
    return obj;
  }
  return injectJson(vm, node);
}

/**
 * Runs one function invocation in a fresh runtime. Host functions return promises inside the VM;
 * the loop drains pending jobs whenever a host call settles until the handler's promise settles.
 * Returns the handler's JSON-compatible result.
 */
export async function runFunction(opts: RunOptions): Promise<unknown> {
  const loaded = loadModule();
  const mod = await loaded;
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(opts.memoryBytes);
  runtime.setMaxStackSize(STACK_BYTES);
  let cpuUsed = 0;
  let sliceStart = 0;
  // Only guest execution counts: host calls (and the JSON injection that settles them) run between
  // slices, and charging their wall time would interrupt the VM the moment a slow host call returned.
  let executing = false;
  runtime.setInterruptHandler(() => executing && cpuUsed + (Date.now() - sliceStart) > opts.cpuMs);
  runtime.setModuleLoader((name) =>
    name === MODULE_NAME ? opts.source : { error: new Error(`imports are not available in ship functions (${name})`) },
  );
  const vm = runtime.newContext();
  const session: Session = { vm, deferreds: new Set(), inflight: 0, wake: () => {} };
  const deadline = Date.now() + opts.wallMs;
  /**
   * Set when this call left objects QuickJS cannot free (an out-of-memory abort, or a host
   * exception that escaped mid-call). `JS_FreeRuntime` would then assert and abort the whole wasm
   * instance — including every concurrent tenant on it — so the runtime is not disposed; instead
   * the module is retired and, once its in-flight calls finish, nothing references it and the GC
   * reclaims the runtime together with the instance and its heap.
   */
  let retired = false;
  const slice = <T>(fn: () => T): T => {
    sliceStart = Date.now();
    executing = true;
    try {
      return fn();
    } finally {
      executing = false;
      cpuUsed += Date.now() - sliceStart;
    }
  };

  /**
   * Turns a guest error message into the HTTP failure. An out-of-memory abort means the shared
   * wasm heap is at its ceiling (`WASM_HEAP_MAX_BYTES`) and will never shrink: retire the module.
   */
  const fail: (message: string) => never = (message) => {
    runtime.setMemoryLimit(-1);
    if (message.includes("interrupted")) throw new HttpError(504, "function exceeded its execution time");
    if (message.includes("out of memory")) {
      retired = true;
      throw new HttpError(500, "function exceeded its memory limit");
    }
    throw new HttpError(500, message);
  };

  try {
    const api = buildApi(session, opts.api);
    vm.setProp(vm.global, "__pyre", api);
    api.dispose();
    const input = injectJson(vm, opts.input);
    vm.setProp(vm.global, "__input", input);
    disposeValue(vm, input);

    const evalResult = slice(() =>
      vm.evalCode(
        `import handler from "${MODULE_NAME}";\nglobalThis.__result = Promise.resolve().then(() => typeof handler === "function" ? handler(globalThis.__input, globalThis.__pyre) : Promise.reject(new TypeError("functions/${opts.filename} must export default a function")));`,
        "pyre-main.js",
        { type: "module" },
      ),
    );
    if (evalResult.error) {
      const message = guestErrorMessage(vm, evalResult.error);
      evalResult.error.dispose();
      fail(message);
    }
    // Module evaluation may itself be a promise (rejected when the function module throws at top level).
    const moduleHandle = evalResult.value;
    try {
      for (;;) {
        const jobs = slice(() => runtime.executePendingJobs());
        if (jobs.error) {
          const message = guestErrorMessage(vm, jobs.error);
          jobs.error.dispose();
          fail(message);
        }
        const moduleState = vm.getPromiseState(moduleHandle);
        if (moduleState.type === "rejected") {
          runtime.setMemoryLimit(-1);
          const message = guestErrorMessage(vm, moduleState.error);
          moduleState.error.dispose();
          fail(message);
        }
        if (moduleState.type === "fulfilled" && !moduleState.notAPromise) moduleState.value.dispose();
        const result = vm.getProp(vm.global, "__result");
        const resultState = vm.getPromiseState(result);
        // `__result` is undefined until the module body has run (notAPromise) — keep waiting in that case.
        const state = resultState.type === "fulfilled" && resultState.notAPromise ? ({ type: "pending" } as const) : resultState;
        result.dispose();
        if (state.type === "fulfilled") {
          runtime.setMemoryLimit(-1);
          const value = vm.dump(state.value) as unknown;
          state.value.dispose();
          return value === undefined ? null : value;
        }
        if (state.type === "rejected") {
          runtime.setMemoryLimit(-1);
          const message = guestErrorMessage(vm, state.error);
          state.error.dispose();
          fail(message);
        }
        if (session.inflight === 0 && !runtime.hasPendingJob()) throw new HttpError(500, "function never settled");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new HttpError(504, "function exceeded its execution time");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          session.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        session.wake = () => {};
      }
    } finally {
      moduleHandle.dispose();
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    retired = true;
    logger.error({ err, filename: opts.filename }, "host: quickjs runtime fault; replacing wasm module");
    throw new HttpError(500, "function runtime fault");
  } finally {
    if (!retired) {
      try {
        for (const d of session.deferreds) d.dispose();
        session.deferreds.clear();
        vm.dispose();
        runtime.dispose();
      } catch (err) {
        // A teardown fault leaves the wasm instance in an unknown state: never reuse it.
        logger.error({ err, filename: opts.filename }, "host: quickjs teardown failed; replacing wasm module");
        retired = true;
      }
    }
    // Retire only the module this call ran on (a concurrent fault may already have replaced it);
    // the wasm was compiled once, so the replacement is a cheap re-instantiation with a fresh heap.
    if (retired && modulePromise === loaded) modulePromise = null;
  }
}

export function serializeResult(value: unknown): string {
  const json = JSON.stringify(value) ?? "null";
  if (Buffer.byteLength(json) > MAX_RESULT_BYTES) throw new HttpError(500, "function result too large");
  return json;
}

/* ─────────────────────────── Scheduling ─────────────────────────── */

const PER_APP_CONCURRENCY = 4;
const GLOBAL_CONCURRENCY = 32;
const MAX_WAITING = 50;

interface Waiter {
  appId: string;
  start: () => void;
}

const activeByApp = new Map<string, number>();
let activeTotal = 0;
const waiting: Waiter[] = [];

function pump(): void {
  for (let i = 0; i < waiting.length && activeTotal < GLOBAL_CONCURRENCY; ) {
    const w = waiting[i] as Waiter;
    if ((activeByApp.get(w.appId) ?? 0) >= PER_APP_CONCURRENCY) {
      i++;
      continue;
    }
    waiting.splice(i, 1);
    activeByApp.set(w.appId, (activeByApp.get(w.appId) ?? 0) + 1);
    activeTotal++;
    w.start();
  }
}

/** Per-app concurrency limit with a bounded FIFO; 503 when the queue is full. */
export async function scheduleFunction<T>(appId: string, work: () => Promise<T>): Promise<T> {
  if (waiting.length >= MAX_WAITING) throw new HttpError(503, "function queue is full, retry shortly");
  await new Promise<void>((start) => {
    waiting.push({ appId, start });
    pump();
  });
  try {
    return await work();
  } finally {
    activeTotal--;
    const n = (activeByApp.get(appId) ?? 1) - 1;
    if (n <= 0) activeByApp.delete(appId);
    else activeByApp.set(appId, n);
    pump();
  }
}
