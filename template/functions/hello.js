/**
 * Server function: runs in the platform's sandbox (QuickJS, 5s CPU, 64MB, no network,
 * no imports). The injected `ship` object is the only capability available:
 *
 *   ship.input                the parsed JSON request body (same value as `input`, `{}` if empty)
 *   ship.user                 always an object: { id: string|null, wallet: string|null, isHolder: boolean };
 *                             `id` is null for anonymous callers
 *   ship.kv.get/set/del(key)  app-wide storage shared by every user
 *                             key: ^[A-Za-z0-9_.:-]{1,120}$, value: JSON <= 64KB
 *   ship.llm(prompt, opts)    one Anthropic (haiku) call, opts.maxTokens <= 1024,
 *                             prompt <= 12000 chars, billed to the app's build budget
 *   ship.fetch(url, body?)    POST JSON to ANOTHER Pyre app's /_pyre/fn/<name> only
 *
 * The return value must be JSON under 1MB; it is what `ship.fn("hello", input)` resolves to.
 *
 * @param {{ name?: unknown }} input
 * @param {{ kv: { get(key: string): Promise<unknown>, set(key: string, value: unknown): Promise<void> } }} ship
 * @returns {Promise<{ greeting: string, hits: number }>}
 */
export default async function handler(input, ship) {
  const raw = typeof input?.name === "string" ? input.name.trim() : "";
  const name = raw === "" ? "world" : raw.slice(0, 40);

  const stored = await ship.kv.get("hello:hits");
  const hits = (typeof stored === "number" && Number.isFinite(stored) ? stored : 0) + 1;
  await ship.kv.set("hello:hits", hits);

  return { greeting: `Hello, ${name}!`, hits };
}
