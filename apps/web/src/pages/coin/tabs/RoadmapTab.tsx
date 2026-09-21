import { useState, type FormEvent } from "react";
import type { AppDetailDto, QueueItemDto } from "@pyre/shared";
import { useAuth } from "../../../auth/useAuth.js";
import { formatPct, formatTokenUnits, timeAgo } from "../../../lib/format.js";
import { Avatar, Button, Chip, EmptyState, Field, Skeleton, Textarea, toast, cx, type ChipTone } from "../../../ui/index.js";
import { useRoadmap, useSubmitPrompt, useVotePrompt } from "../queries.js";
import { describeError } from "../trade.js";

const STATUS: Record<QueueItemDto["status"], { label: string; tone: ChipTone }> = {
  OPEN: { label: "open", tone: "neutral" },
  SCHEDULED: { label: "scheduled", tone: "build" },
  DONE: { label: "shipped", tone: "earn" },
  REJECTED: { label: "declined", tone: "burn" },
};

const ORDER: Record<QueueItemDto["status"], number> = { SCHEDULED: 0, OPEN: 1, DONE: 2, REJECTED: 3 };

/** Holder-weighted prompt queue: what the agent builds next, voted with $TICKER. */
export const RoadmapTab = ({ app }: { app: AppDetailDto }) => {
  const auth = useAuth();
  const roadmap = useRoadmap(app.slug);
  const submit = useSubmitPrompt(app.slug);
  const vote = useVotePrompt(app.slug);
  const [text, setText] = useState("");

  const items = (roadmap.data?.items ?? []).slice().sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.votes - a.votes);
  const canSubmit = roadmap.data?.canSubmit ?? false;
  const minHold = roadmap.data ? BigInt(roadmap.data.minHoldUnits) : 0n;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = text.trim();
    if (clean.length < 10) return;
    try {
      await submit.mutateAsync(clean);
      setText("");
      toast.success("Added to the roadmap", { description: "Holders can now vote it up." });
    } catch (err) {
      toast.error("Could not submit", { description: describeError(err) });
    }
  };

  const onVote = async (id: string) => {
    try {
      await vote.mutateAsync(id);
    } catch (err) {
      toast.error("Vote failed", { description: describeError(err) });
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-12 text-ink-3">
          <Chip size="sm" mono>{app.roadmap.open} open</Chip>
          <Chip size="sm" mono tone="build">{app.roadmap.scheduled} scheduled</Chip>
          <Chip size="sm" mono tone="earn">{app.roadmap.done} shipped</Chip>
          <span className="num ml-auto">votes weigh by $${app.ticker} held, capped per wallet</span>
        </div>
        {roadmap.isPending ? (
          <Skeleton lines={6} />
        ) : items.length === 0 ? (
          <EmptyState title="Nothing proposed yet" body="Holders steer the agent. Propose the next feature and vote with your coins." />
        ) : (
          <ol className="divide-y divide-line rounded-card border border-line">
            {items.map((it) => (
              <li key={it.id} className={cx("flex gap-3 p-3", it.status === "REJECTED" && "ash")}>
                <button
                  type="button"
                  onClick={() => onVote(it.id)}
                  disabled={!auth.authenticated || vote.isPending || it.status !== "OPEN"}
                  aria-pressed={it.votedByMe}
                  aria-label={`Vote for: ${it.text.slice(0, 60)}`}
                  className={cx(
                    "num flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-control border text-12 transition-colors duration-(--duration-ui) ease-(--ease-ui) disabled:cursor-not-allowed disabled:opacity-60",
                    it.votedByMe ? "border-accent bg-accent-wash text-accent" : "border-line-2 bg-fill text-ink-2 hover:not-disabled:border-line-3 hover:not-disabled:text-ink",
                  )}
                >
                  <span aria-hidden>▲</span>
                  <span className="font-medium">{it.votes}</span>
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={STATUS[it.status].tone} size="sm" mono>
                      {STATUS[it.status].label}
                    </Chip>
                    <span className="num text-12 text-ink-3">{formatPct(it.weightPctOfSupply / 100, 2)} of supply behind it</span>
                    <span className="num ml-auto text-12 text-ink-3">{timeAgo(it.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-14 text-ink">{it.text}</p>
                  <div className="mt-1.5 inline-flex items-center gap-1.5 text-12 text-ink-3">
                    <Avatar src={it.author.avatarUrl} name={it.author.displayName ?? "holder"} size={14} />
                    {it.author.displayName ?? "anonymous"}
                    {it.jobId && <span className="num">· job {it.jobId.slice(0, 8)}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <form onSubmit={onSubmit} className="flex h-fit flex-col gap-3 rounded-card border border-line bg-surface p-4">
        <div>
          <div className="eyebrow">Propose</div>
          <p className="small mt-1 text-ink-2">Tell the agent what to build next. Holders of at least {formatTokenUnits(minHold)} ${app.ticker} can propose.</p>
        </div>
        <Field label="Prompt" hint={roadmap.data && !canSubmit && auth.authenticated ? "Hold more $" + app.ticker + " to propose." : undefined}>
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a leaderboard that resets weekly…" maxLength={600} disabled={!auth.authenticated || !canSubmit} />
        </Field>
        {auth.authenticated ? (
          <Button type="submit" variant="primary" disabled={!canSubmit || text.trim().length < 10} loading={submit.isPending}>
            Submit to roadmap
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={auth.signIn}>
            Sign in to propose
          </Button>
        )}
        {roadmap.data && auth.authenticated && (
          <p className="num text-12 text-ink-3">your vote weight: {formatTokenUnits(roadmap.data.myWeightUnits)}</p>
        )}
      </form>
    </div>
  );
};
