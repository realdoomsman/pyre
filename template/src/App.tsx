import { useState } from "react";
import { ship, pyreEnv } from "@pyre/app-sdk";
import { HolderGate, LoginButton, usePyre } from "@pyre/app-sdk/react";
import { Button, Card, Chip, EmptyState, Input, PageHeader } from "./components";

/** Return value of `functions/hello.js`. */
interface Hello {
  greeting: string;
  hits: number;
}

export default function App() {
  const env = pyreEnv();
  const { user, holder } = usePyre();
  const [name, setName] = useState("");
  const [hello, setHello] = useState<Hello | null>(null);
  const [helloError, setHelloError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

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
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-5 py-8 sm:px-6 sm:py-12">
      <PageHeader
        actions={<LoginButton className="h-10 rounded-card border border-border bg-surface px-4 text-sm font-medium text-ink hover:border-border-strong">Log in</LoginButton>}
        description="Built by an agent. Free to use. Its coin's trading fees pay for every build."
        eyebrow={env.ticker ? `$${env.ticker}` : "pyre app"}
        title={env.name ?? "Pyre Starter"}
      />

      <Card
        actions={<Chip>functions/hello.js</Chip>}
        description="Runs a server function on the platform. No login needed."
        title="Say hello"
      >
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void runHello();
          }}
        >
          <Input
            className="flex-1"
            label="Your name"
            onChange={(e) => setName(e.target.value)}
            placeholder="your name"
            value={name}
          />
          <Button disabled={running} type="submit">
            {running ? "Running…" : "Run hello"}
          </Button>
        </form>
        {hello ? (
          <p className="mt-4 text-sm text-ink" data-testid="hello-result">
            {hello.greeting} — called{" "}
            <span className="font-mono tabular-nums text-violet">{hello.hits}</span> {hello.hits === 1 ? "time" : "times"}{" "}
            so far.
          </p>
        ) : helloError ? (
          <p className="mt-4 text-sm text-danger" role="alert">
            {helloError}
          </p>
        ) : (
          <EmptyState className="mt-4" description="The result of the function call shows up here." title="Nothing yet" />
        )}
      </Card>

      <Card
        actions={<Chip tone="violet">holders</Chip>}
        description="Extra depth for people holding the app's coin. No purchase, no paywall."
        title="Holders only"
      >
        <HolderGate
          fallback={
            <p className="text-sm text-ink-muted" data-testid="holder-locked">
              Hold at least <span className="font-mono tabular-nums text-ink">{holder.minHold}</span>{" "}
              {env.ticker ? `$${env.ticker}` : "coins"} to see this section.
            </p>
          }
        >
          <p className="text-sm text-ink" data-testid="holder-unlocked">
            Welcome, holder. Your balance is{" "}
            <span className="font-mono tabular-nums text-violet">{holder.balance}</span>.
          </p>
        </HolderGate>
      </Card>

      <footer className="mt-auto border-t border-border pt-6 text-sm text-ink-faint">
        {user ? `Signed in as ${user.displayName ?? user.wallet ?? user.id}. ` : ""}
        Powered by Pyre.
      </footer>
    </div>
  );
}
