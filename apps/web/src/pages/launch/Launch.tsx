import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import type { AppSpec, CreateLaunchBody, LaunchDraftDto } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { useApp, useMe } from "../../api/queries.js";
import { useAuth } from "../../auth/useAuth.js";
import { CoinCard } from "../../components/CoinCard.js";
import { duration, ease, spring, useReducedMotion } from "../../lib/motion.js";
import { Button, Skeleton, cx } from "../../ui/index.js";
import { useApproveSpec, useCreateLaunch, useForkLaunch, useLaunchDraft, useStake } from "./hooks.js";
import { Launching } from "./Launching.js";
import { EMPTY_DRAFT, previewApp, type CoinDraft } from "./preview.js";
import { BriefGenerating, StepBrief } from "./StepBrief.js";
import { StepCoin } from "./StepCoin.js";
import { StepReview } from "./StepReview.js";

type Step = 1 | 2 | 3;
const STEPS: ReadonlyArray<{ n: Step; label: string }> = [
  { n: 1, label: "Coin" },
  { n: 2, label: "Agent brief" },
  { n: 3, label: "Review & launch" },
];

const STEP_OF: Record<LaunchDraftDto["status"], Step> = {
  DRAFT: 2,
  SPEC_READY: 2,
  AWAITING_STAKE: 3,
  LAUNCHING: 3,
  LAUNCH_GATED: 3,
  LIVE: 3,
  DORMANT: 3,
  KILLED: 3,
  FAILED: 3,
};

/** Rail of the three step names: the current one lit, a hairline that fills underneath. */
const StepRail = ({ step, reachable, onJump }: { step: Step; reachable: Step; onJump: (s: Step) => void }) => (
  <nav aria-label="Launch steps" className="flex flex-col gap-2">
    <ol className="flex items-baseline gap-x-4 text-14">
      {STEPS.map((s) => {
        const current = s.n === step;
        const can = s.n <= reachable && !current;
        return (
          <li key={s.n} className="flex items-baseline gap-2">
            <span className={cx("num text-12", current ? "text-accent" : "text-ink-3")}>0{s.n}</span>
            <button
              type="button"
              disabled={!can}
              onClick={() => onJump(s.n)}
              aria-current={current ? "step" : undefined}
              className={cx("font-medium transition-colors duration-(--duration-ui)", current ? "text-ink" : can ? "text-ink-2 hover:text-ink" : "cursor-default text-ink-3")}
            >
              {s.label}
            </button>
          </li>
        );
      })}
    </ol>
    <div className="h-px w-full bg-line">
      <div className="h-px bg-accent transition-[width] duration-(--duration-reveal) ease-(--ease-reveal)" style={{ width: `${(step / 3) * 100}%` }} />
    </div>
  </nav>
);

const errorText = (e: unknown): string | null => (e == null ? null : isHttpError(e) ? e.message : e instanceof Error ? e.message : "Something went wrong.");

export const Launch = () => {
  const auth = useAuth();
  const me = useMe();
  const reduced = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const id = params.get("id");
  const forkSlug = params.get("fork");
  const forkApp = useApp(forkSlug ?? undefined);

  const launch = useLaunchDraft(id);
  const create = useCreateLaunch();
  const fork = useForkLaunch(forkSlug ?? "");
  const approve = useApproveSpec(id ?? "");
  const stake = useStake(id ?? "");

  const [draft, setDraft] = useState<CoinDraft>(EMPTY_DRAFT);
  /** The user stepped back to look at an earlier tray; cleared on the next server transition. */
  const [peek, setPeek] = useState<Step | null>(null);

  useEffect(() => {
    document.title = "Launch a coin — Pyre";
  }, []);

  // Fork: prefill the coin form from the parent.
  useEffect(() => {
    if (!forkApp.data || id) return;
    const p = forkApp.data;
    setDraft((d) => (d.prompt ? d : { ...d, prompt: p.spec ? `${p.spec.oneLiner}\n\n${p.spec.whatItDoes}` : p.oneLiner, imageUrl: d.imageUrl || p.imageUrl }));
  }, [forkApp.data, id]);

  const data = launch.data;
  // Intake moderation refuses with FAILED and no spec: back to the coin tray with the reason.
  const rejected = !!data && data.status === "FAILED" && !data.spec;
  const serverStep: Step = !data || rejected ? 1 : STEP_OF[data.status];
  const step: Step = peek ?? serverStep;

  useEffect(() => setPeek(null), [data?.status]);

  // Keep the local draft in sync with the server copy so the preview never regresses.
  useEffect(() => {
    if (!data) return;
    setDraft((d) => ({
      name: d.name || data.name,
      ticker: d.ticker || data.ticker,
      imageUrl: d.imageUrl || data.imageUrl,
      prompt: d.prompt || data.prompt,
      twitter: d.twitter || data.twitterUrl || "",
      website: d.website || data.websiteUrl || "",
    }));
  }, [data]);

  const preview = useMemo(() => previewApp(draft, rejected ? undefined : data, me.data ?? null), [draft, data, rejected, me.data]);

  const submitCoin = (body: CreateLaunchBody) => {
    const onSuccess = (l: LaunchDraftDto) => setParams({ id: l.id }, { replace: true });
    if (forkSlug && !id) fork.mutate(body, { onSuccess });
    else create.mutate(body, { onSuccess });
  };

  const restart = () => {
    setParams({}, { replace: true });
    setPeek(null);
  };

  if (!auth.ready) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" rounded="card" />
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 lg:flex-row lg:items-start lg:gap-12">
        <div className="flex max-w-xl flex-col gap-5">
          <h1 className="h1">
            Launch a coin that <em>builds</em> something.
          </h1>
          <p className="body text-ink-2">
            Name it, tell the agent what to build, stake 0.002 ETH. The coin launches on PONS v2; its creator fees fund the agent; the app's revenue buys the coin back and burns it.
          </p>
          <div>
            <Button size="lg" onClick={auth.signIn}>
              Sign in to launch
            </Button>
          </div>
          <p className="small text-ink-3">Google gives you a custodial Pyre wallet on Robinhood Chain. Or sign in with your own wallet and pay the stake from it.</p>
        </div>
        <div className="w-full max-w-sm lg:sticky lg:top-24">
          <CoinCard app={preview} />
        </div>
      </div>
    );
  }

  const transition = reduced ? { duration: duration.ui, ease: ease.ui } : spring.tray;

  let tray: { key: string; node: ReactElement };
  if (step === 1) {
    tray = {
      key: "coin",
      node: (
        <StepCoin
          draft={draft}
          onChange={setDraft}
          onSubmit={submitCoin}
          busy={create.isPending || fork.isPending}
          rejection={rejected ? (data?.killedReason ?? "The prompt was refused by the launch classifier.") : errorText(create.error ?? fork.error)}
          forking={forkSlug && !id ? (forkApp.data?.ticker ?? forkSlug) : null}
        />
      ),
    };
  } else if (step === 2) {
    tray =
      data?.spec && data.status !== "DRAFT"
        ? {
            key: "brief",
            node: (
              <StepBrief
                key={data.id}
                spec={data.spec}
                ticker={data.ticker}
                busy={approve.isPending}
                error={errorText(approve.error)}
                onApprove={(spec: AppSpec) => approve.mutate(spec)}
                onBack={() => setPeek(1)}
              />
            ),
          }
        : { key: "generating", node: <BriefGenerating ticker={draft.ticker} /> };
  } else if (data && data.status === "AWAITING_STAKE" && data.spec) {
    tray = {
      key: "review",
      node: (
        <StepReview
          launch={data}
          spec={data.spec}
          me={me.data ?? null}
          busy={stake.isPending}
          error={errorText(stake.error)}
          onStake={(body) => stake.mutate(body)}
          onBack={() => setPeek(2)}
        />
      ),
    };
  } else if (data) {
    tray = { key: "launching", node: <Launching launch={data} onRestart={restart} /> };
  } else {
    tray = { key: "loading", node: <Skeleton className="h-64" rounded="card" /> };
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="h1">
          Launch a <em>coin</em>.
        </h1>
        <p className="body max-w-2xl text-ink-2">Three steps. The card on the right is exactly what the feed will show the moment it is live.</p>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-12">
        <div className="flex min-w-0 flex-col gap-6">
          <StepRail step={step} reachable={serverStep} onJump={(s) => setPeek(s === serverStep ? null : s)} />
          <motion.section layout transition={transition} className="overflow-hidden rounded-card border border-line bg-surface">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tray.key}
                initial={reduced ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: duration.reveal, ease: ease.reveal }}
                className="p-5 sm:p-6"
              >
                {tray.node}
              </motion.div>
            </AnimatePresence>
          </motion.section>
          {launch.isError && (
            <p role="alert" className="text-13 text-danger">
              {errorText(launch.error)}
            </p>
          )}
        </div>

        <aside className="order-first flex flex-col gap-3 lg:order-none lg:sticky lg:top-24 lg:self-start">
          <div className="eyebrow">Live preview</div>
          <CoinCard app={preview} />
          <p className="small text-ink-3">Zero everything, because nothing has happened yet. Every number on this card is read from the chain once the coin exists.</p>
        </aside>
      </div>
    </div>
  );
};
