import { useState } from "react";
import { ship, pyreEnv } from "@pyre/app-sdk";
import { AdSlot, Checkout, HolderGate, LoginButton, usePyre } from "@pyre/app-sdk/react";

/** Return value of `functions/hello.js`. */
interface Hello {
  greeting: string;
  hits: number;
}

/** Must match an `id` in `pyre.manifest.json` → `products`. */
const PRODUCT_ID = "pro-unlock";

export default function App() {
  const env = pyreEnv();
  const { user, holder, purchases, refresh } = usePyre();
  const [name, setName] = useState("");
  const [hello, setHello] = useState<Hello | null>(null);
  const [helloError, setHelloError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const owned = purchases.includes(PRODUCT_ID);

  const runHello = async (): Promise<void> => {
    setRunning(true);
    setHelloError(null);
    try {
      setHello(await ship.fn<Hello>("hello", { name }));
    } catch (cause) {
      setHelloError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{env.name ?? "Pyre Starter"}</h1>
          <p className="mt-1 text-sm text-white/60">
            {env.ticker ? `$${env.ticker} · ` : ""}built by an agent, funded by its coin
          </p>
        </div>
        <LoginButton className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10">
          Log in
        </LoginButton>
      </header>

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h2 className="text-lg font-semibold">Say hello</h2>
        <p className="mt-1 text-sm text-white/60">
          Runs <code className="text-white/80">functions/hello.js</code> on the platform — free, no login needed.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <input
            aria-label="Your name"
            className="min-w-48 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-2 outline-none focus:border-white/40"
            onChange={(e) => setName(e.target.value)}
            placeholder="your name"
            value={name}
          />
          <button
            className="rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-black disabled:opacity-50"
            disabled={running}
            onClick={() => void runHello()}
            type="button"
          >
            {running ? "Running…" : "Run hello"}
          </button>
        </div>
        {hello ? (
          <p className="mt-4 text-emerald-300" data-testid="hello-result">
            {hello.greeting} — called {hello.hits} {hello.hits === 1 ? "time" : "times"} so far.
          </p>
        ) : null}
        {helloError ? (
          <p className="mt-4 text-red-400" role="alert">
            {helloError}
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h2 className="text-lg font-semibold">Pro unlock</h2>
        <p className="mt-1 text-sm text-white/60">
          A one-time purchase in USDG on Robinhood Chain. The platform charges your Pyre wallet and confirms the
          payment; revenue flows straight into the app&apos;s buyback and build budget.
        </p>
        <div className="mt-4">
          <Checkout
            className="rounded-lg bg-white px-4 py-2 font-semibold text-black disabled:opacity-50"
            onPaid={() => void refresh()}
            productId={PRODUCT_ID}
          />
        </div>
        {owned ? (
          <p className="mt-4 rounded-lg bg-emerald-500/10 p-4 text-emerald-200" data-testid="pro-content">
            Pro is unlocked. Put the paid feature here.
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h2 className="text-lg font-semibold">Holders only</h2>
        <HolderGate
          fallback={
            <p className="mt-2 text-sm text-white/60" data-testid="holder-locked">
              Hold at least {holder.minHold} {env.ticker ? `$${env.ticker}` : "coins"} to see this section.
            </p>
          }
        >
          <p className="mt-2 text-sm text-emerald-200" data-testid="holder-unlocked">
            Welcome, holder. Your balance is {holder.balance}.
          </p>
        </HolderGate>
      </section>

      <footer className="mt-auto flex flex-col gap-4 border-t border-white/10 pt-6 text-sm text-white/50">
        <AdSlot className="flex items-center gap-3 rounded-xl border border-white/10 p-3 text-white/80 no-underline" />
        <p>
          {user ? `Signed in as ${user.displayName ?? user.wallet ?? user.id}. ` : ""}
          Powered by Pyre.
        </p>
      </footer>
    </div>
  );
}
