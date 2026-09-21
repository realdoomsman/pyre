import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import tar from "tar-stream";

/** Directories never shipped into a sandbox from a local asset tree. */
const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  ".git": true,
  "test-results": true,
  "playwright-report": true,
};

export type TarSource = { dir: string; prefix: string; skipTopLevel?: Record<string, true> };

const walk = async (root: string, dir: string, skipTop: Record<string, true>, out: string[]): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      if (SKIP_DIRS[entry.name] || (dir === root && skipTop[entry.name])) continue;
      await walk(root, full, skipTop, out);
    } else if (entry.isFile()) {
      if (dir === root && skipTop[entry.name]) continue;
      out.push(rel);
    }
  }
};

/** Pack local directories into one gzip tarball buffer, each under its `prefix`. */
export const packDirs = async (sources: TarSource[]): Promise<Buffer> => {
  const pack = tar.pack();
  const gzip = createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  const done = pipeline(pack, gzip, async function (src) {
    for await (const chunk of src) chunks.push(chunk as Buffer);
  });
  for (const src of sources) {
    const files: string[] = [];
    await walk(src.dir, src.dir, src.skipTopLevel ?? {}, files);
    for (const rel of files) {
      const full = join(src.dir, rel);
      const info = await stat(full);
      const name = posix.join(src.prefix, rel.split("\\").join("/"));
      await new Promise<void>((res, rej) => {
        const entry = pack.entry({ name, size: info.size, mode: 0o644, mtime: info.mtime }, (err) =>
          err ? rej(err) : res(),
        );
        createReadStream(full).pipe(entry);
      });
    }
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
};

export type TarEntry = { path: string; body: Uint8Array<ArrayBuffer> };

/** Extract every regular file from a gzip tarball. Throws if total extracted size exceeds `maxBytes`. */
export const extractTgz = async (tgz: Uint8Array, maxBytes: number): Promise<TarEntry[]> => {
  const entries: TarEntry[] = [];
  let total = 0;
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of stream) {
        if (header.type !== "file" || !(chunk instanceof Uint8Array)) continue;
        total += chunk.length;
        if (total > maxBytes) throw new Error(`bundle exceeds ${maxBytes} bytes`);
        chunks.push(chunk);
        size += chunk.length;
      }
      if (header.type === "file") {
        const body = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          body.set(c, offset);
          offset += c.length;
        }
        entries.push({ path: header.name.replace(/^\.\//, "").replace(/^\/+/, ""), body });
      }
      next();
    })().catch((e: unknown) => extract.destroy(e instanceof Error ? e : new Error(String(e))));
  });
  await pipeline(Readable.from([tgz]), createGunzip(), extract);
  return entries;
};
