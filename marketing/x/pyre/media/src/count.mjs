// X-weighted character counts for every ``` block in posts2.md (URLs 23, most non-Latin
// code points 2, the rest 1), and the entry/media tallies the assignment asks for.
//   node src/count.mjs
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(join(ROOT, "posts2.md"), "utf8");

const light = (cp) => cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
export const weigh = (text) => {
  let n = 0;
  const stripped = text.replace(/https?:\/\/\S+|(?:^|\s)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi, (m) => { n += 23 + (m.startsWith(" ") || m.startsWith("\n") ? 1 : 0); return ""; });
  for (const ch of stripped.normalize("NFC")) n += light(ch.codePointAt(0)) ? 1 : 2;
  return n;
};

const entries = [...md.matchAll(/^## (\d+) · ([^\n]+)\n([\s\S]*?)```\n([\s\S]*?)```/gm)].map((m) => ({ n: m[1], slug: m[2].trim(), head: m[3], copy: m[4].trimEnd() }));
let bad = 0;
for (const e of entries) {
  const c = weigh(e.copy);
  const media = [...e.head.matchAll(/`([^`]+\.(?:mp4|png|srt))`/g)].map((x) => x[1]);
  const missing = media.filter((f) => !existsSync(join(ROOT, f)));
  const cashtag = /\$PYRE/.test(e.copy);
  const ok = c <= 280 && !missing.length && !cashtag;
  if (!ok) bad++;
  console.log(`${ok ? "ok " : "BAD"} ${e.n} ${e.slug.padEnd(16)} ${String(c).padStart(3)}/280  media: ${media.map((f) => `${f}${missing.includes(f) ? " (missing)" : ` ${(statSync(join(ROOT, f)).size / 1048576).toFixed(1)}MB`}`).join(", ")}${cashtag ? "  $PYRE cashtag!" : ""}`);
}
const videos = entries.filter((e) => /\.mp4`/.test(e.head)).length;
console.log(`\n${entries.length} entries · ${videos} video · ${entries.length - videos} image · ${bad} problems`);
process.exitCode = bad ? 1 : 0;
