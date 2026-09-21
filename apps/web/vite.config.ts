import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/*
 * Chunking.
 *
 * The sign-in stack — Google Identity Services and viem for the wallet
 * challenge — is reachable only through the lazy import in
 * `auth/AuthProvider.tsx` (which loads `auth/SignInSheet.tsx`) and the
 * on-demand `lib/wallet.ts`, so no other module may import those packages
 * statically. Layered chunks keep the graph a DAG:
 *
 *     react ← query          react, zod ← entry
 *     base  ← wallet → react, query
 *     chart (leaf)
 *
 * `base` is the catch-all *bottom* layer, and that direction is deliberate: a
 * package we forget to classify becomes a size regression on the lazy pages —
 * which `pyre:bundle-budget` and `scripts/audit.mjs` both catch — rather than a
 * chunk cycle that only shows up as a runtime crash.
 */
const WALLET_PACKAGES = /^@react-oauth\//;

/*
 * viem and its primitives are used two ways: `@pyre/shared` needs a checksum
 * helper on every page, while the trade panel and the sign-in sheet need the
 * wallet client. Forcing the family into one chunk would drag all of it into
 * the entry graph, so these are left to rollup's per-module splitting: the
 * handful of modules the entry uses land next to it, the rest stay lazy.
 */
const AUTO_SPLIT = /^(viem|ox|abitype|@noble\/|@scure\/|@adraffy\/|isows|ws|eventemitter3)/;

const VENDOR_CHUNKS: Array<{ chunk: string; packages: RegExp }> = [
  { chunk: "react", packages: /^(react|react-dom|react-is|scheduler|react-router|react-router-dom|use-sync-external-store)$/ },
  { chunk: "query", packages: /^@tanstack\// },
  { chunk: "zod", packages: /^zod$/ },
  { chunk: "chart", packages: /^(lightweight-charts|fancy-canvas)$/ },
  // Only lazy surfaces (sheets, ⌘K, launch) animate with motion; its own chunk keeps it off the entry.
  { chunk: "motion", packages: /^(motion|framer-motion|motion-dom|motion-utils)$/ },
  { chunk: "wallet", packages: WALLET_PACKAGES },
];

/** Owning package of a module id, following nested installs to the innermost one. */
const packageOf = (path: string): string | undefined => {
  const at = path.lastIndexOf("node_modules/");
  if (at < 0) return undefined;
  return /^((?:@[^/]+\/)?[^/]+)/.exec(path.slice(at + "node_modules/".length))?.[1];
};

/**
 * Preloads what the first paint is actually blocked on: the entry module and the
 * latin subsets of the two variable fonts, plus a preconnect to the API the first
 * query hits. Font filenames are content hashed, so the hrefs have to be read off
 * the bundle rather than hardcoded in `index.html`.
 */
const preloadCriticalAssets = (): Plugin => {
  let apiOrigin = "";
  return {
    name: "pyre:preload-critical-assets",
    apply: "build",
    configResolved(config) {
      try {
        apiOrigin = new URL(config.env.VITE_API_ORIGIN as string).origin;
      } catch {
        apiOrigin = "";
      }
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const link = (attrs: Record<string, string>) => ({ tag: "link", attrs, injectTo: "head-prepend" as const });
        /*
         * The faces the first paint blocks on: Inter for body copy, JetBrains
         * Mono for every number, and both Silkscreen weights, which set display
         * type and labels above the fold. Latin subsets only — the rest are
         * unicode-range gated and never fetched for English. woff2 only:
         * fontsource also emits a legacy .woff for each face, which no browser
         * that supports preload will ever pick. Filenames are content hashed, so
         * they have to be read off the bundle.
         */
        const fonts = Object.keys(ctx.bundle ?? {}).filter((file) =>
          /(?:(?:inter|jetbrains-mono)-latin-wght-normal|silkscreen-latin-[47]00-normal)-[^/]*\.woff2$/.test(file),
        );
        return [
          ...(apiOrigin ? [link({ rel: "preconnect", href: apiOrigin, crossorigin: "" })] : []),
          ...fonts.map((file) => link({ rel: "preload", as: "font", type: "font/woff2", href: `/${file}`, crossorigin: "" })),
          // Vite emits modulepreload for the entry's *imports*, not the entry itself.
          ...(ctx.chunk ? [link({ rel: "modulepreload", href: `/${ctx.chunk.fileName}`, crossorigin: "" })] : []),
        ];
      },
    },
  };
};

/*
 * `sirv` in `server.mjs` serves `.br`/`.gz` siblings when the client asks for
 * them, and Vite does not emit any, so every asset was going out uncompressed:
 * 3.4 MB of JS on the wire instead of 1 MB. Compress at build time — once, at max
 * level — rather than per request in Node.
 *
 * This has to happen in `writeBundle`, reading the files back off disk. Vite's
 * own internal post plugins run *after* user post plugins, and one of them
 * replaces the `__VITE_PRELOAD__` placeholder in `generateBundle` — compressing
 * chunk.code there ships a .gz whose JS still contains the placeholder, and the
 * page dies with "__VITE_PRELOAD__ is not defined".
 */
const COMPRESSIBLE = /\.(js|css|html|svg|json)$/;

const precompressAssets = (): Plugin => ({
  name: "pyre:precompress",
  apply: "build",
  enforce: "post",
  writeBundle(options, bundle) {
    const dir = options.dir;
    if (!dir) return;
    for (const fileName of Object.keys(bundle)) {
      if (!COMPRESSIBLE.test(fileName)) continue;
      const file = join(dir, fileName);
      // A second build writing the same outDir can have the file mid-replace.
      // Skipping one sibling is a missing optimisation; throwing here would kill
      // the whole build with no usable message.
      if (!existsSync(file)) {
        this.warn(`precompress: ${fileName} vanished before compression — another build writing ${dir}?`);
        continue;
      }
      const raw = readFileSync(file);
      // Below ~1 kB the header overhead makes compression pointless.
      if (raw.byteLength < 1024) continue;
      writeFileSync(
        `${file}.br`,
        brotliCompressSync(raw, {
          params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.byteLength },
        }),
      );
      writeFileSync(`${file}.gz`, gzipSync(raw, { level: 9 }));
    }
  },
});

/*
 * Budget enforcement, in the build rather than in CI only.
 *
 * Vite's `chunkSizeWarningLimit` is one number applied to every chunk, which
 * cannot express the thing we care about: the initial graph must stay small, the
 * numbers that matter are the compressed ones a browser actually downloads, and
 * the deferred wallet chunk is allowed to be large because no first paint waits
 * on it. So this plugin states those budgets and fails the build when one is
 * blown. `chunkSizeWarningLimit` is set above the wallet chunk purely so the two
 * checks do not both shout; this plugin is the one with teeth, and
 * `scripts/audit.mjs` re-measures the same thing through a real browser.
 */
const BUDGETS = {
  /** Transferred (gzip) kB of any one chunk the HTML entry statically depends on. */
  initialChunkKb: 120,
  /** Transferred (gzip) kB of the whole initial graph: entry + its static imports. */
  initialTotalKb: 180,
  /** Raw kB of any lazily loaded chunk. The viem + GIS sign-in stack sets this floor. */
  lazyChunkKb: 1200,
};

const bundleBudget = (): Plugin => ({
  name: "pyre:bundle-budget",
  apply: "build",
  enforce: "post",
  writeBundle(options, bundle) {
    const dir = options.dir;
    if (!dir) return;
    const chunks = Object.values(bundle).filter((o): o is Extract<typeof o, { type: "chunk" }> => o.type === "chunk");
    const byFile: Record<string, string[]> = {};
    for (const chunk of chunks) byFile[chunk.fileName] = chunk.imports;
    const entry = chunks.find((c) => c.isEntry);
    if (!entry) return;

    const initial = new Set<string>();
    const walk = (fileName: string) => {
      if (initial.has(fileName)) return;
      initial.add(fileName);
      for (const dep of byFile[fileName] ?? []) walk(dep);
    };
    walk(entry.fileName);

    const sizeOf = (fileName: string) => {
      const file = join(dir, fileName);
      const raw = statSync(file).size;
      // What the browser gets: the precompressed sibling when we made one.
      const gzip = existsSync(`${file}.gz`) ? statSync(`${file}.gz`).size : raw;
      return { raw, gzip };
    };

    const problems: string[] = [];
    let initialGzip = 0;
    for (const fileName of initial) {
      const { gzip } = sizeOf(fileName);
      initialGzip += gzip;
      if (gzip / 1024 > BUDGETS.initialChunkKb) {
        problems.push(`${fileName} is ${(gzip / 1024).toFixed(0)} kB gzipped in the initial graph (limit ${BUDGETS.initialChunkKb} kB)`);
      }
      if (/(^|\/)wallet-/.test(fileName)) {
        problems.push(`${fileName} is in the initial graph — something imports the sign-in stack outside the lazy auth/SignInSheet.tsx`);
      }
    }
    if (initialGzip / 1024 > BUDGETS.initialTotalKb) {
      problems.push(
        `initial graph is ${(initialGzip / 1024).toFixed(0)} kB gzipped across ${initial.size} chunks (limit ${BUDGETS.initialTotalKb} kB)`,
      );
    }
    for (const chunk of chunks) {
      if (initial.has(chunk.fileName)) continue;
      const { raw } = sizeOf(chunk.fileName);
      if (raw / 1024 > BUDGETS.lazyChunkKb) {
        problems.push(`${chunk.fileName} is ${(raw / 1024).toFixed(0)} kB raw (lazy limit ${BUDGETS.lazyChunkKb} kB)`);
      }
    }

    const summary = `initial graph ${(initialGzip / 1024).toFixed(1)} kB gzipped across ${initial.size} chunks`;
    if (problems.length) this.error(`bundle budget blown — ${summary}\n  - ${problems.join("\n  - ")}`);
    this.warn(`budget ok — ${summary}`);
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadCriticalAssets(), precompressAssets(), bundleBudget()],
  build: {
    target: "es2022",
    sourcemap: false,
    // Superseded by pyre:bundle-budget above, which enforces the real budgets
    // (initial graph small, deferred sign-in chunk capped). Set above that chunk
    // so one deliberate deferred bundle does not print a warning that says
    // nothing the stricter check does not already say.
    chunkSizeWarningLimit: BUDGETS.lazyChunkKb,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replace(/\\/g, "/");
          // Vite's dynamic-import helper is imported by every chunk that has a
          // dynamic import. Left unassigned, rollup parks it in whichever vendor
          // chunk it likes — and if that is the wallet chunk, the entry statically
          // imports the wallet stack again. Pin it to a chunk the entry already
          // needs and that imports nothing itself.
          if (path.includes("vite/preload-helper")) return "react";
          const pkg = packageOf(path);
          if (!pkg || AUTO_SPLIT.test(pkg)) return;
          return VENDOR_CHUNKS.find((v) => v.packages.test(pkg))?.chunk ?? "base";
        },
      },
    },
  },
});
