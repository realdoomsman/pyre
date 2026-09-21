import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ProposalDto } from "@pyre/shared";
import { PLATFORM_PROPOSAL_MIN_HOLD_BPS, PLATFORM_PROPOSAL_QUORUM_BPS, PLATFORM_PROPOSAL_STALE_DAYS, VOTE_WALLET_CAP_BPS } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { useMe } from "../../api/queries.js";
import { useAuth } from "../../auth/useAuth.js";
import { formatBps, formatTokenUnits, timeAgo } from "../../lib/format.js";
import { Avatar, Button, Card, Chip, EmptyState, Field, Input, Progress, Select, Sheet, Skeleton, Tabs, Textarea, cx, toast, type ChipTone } from "../../ui/index.js";
import { useAddComment, useComments, useProposals, useSetStatus, useSubmitProposal, useVote, type ProposalsPage } from "./hooks.js";

type Status = ProposalDto["status"];
type Filter = "OPEN" | "ROADMAP" | "SHIPPED" | "DECLINED";

const STATUS: Record<Status, { label: string; tone: ChipTone }> = {
  OPEN: { label: "Open", tone: "neutral" },
  PLANNED: { label: "Planned", tone: "accent" },
  BUILDING: { label: "Building", tone: "build" },
  SHIPPED: { label: "Shipped", tone: "earn" },
  DECLINED: { label: "Declined", tone: "burn" },
};

const FILTERS: ReadonlyArray<{ id: Filter; label: string; statuses: Status[] }> = [
  { id: "OPEN", label: "Open", statuses: ["OPEN"] },
  { id: "ROADMAP", label: "Roadmap", statuses: ["PLANNED", "BUILDING"] },
  { id: "SHIPPED", label: "Shipped", statuses: ["SHIPPED"] },
  { id: "DECLINED", label: "Declined", statuses: ["DECLINED"] },
];

export const Governance = () => {
  const auth = useAuth();
  const me = useMe();
  const q = useProposals();
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [composing, setComposing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Governance — Pyre";
  }, []);

  const page = q.data;
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { OPEN: 0, ROADMAP: 0, SHIPPED: 0, DECLINED: 0 };
    for (const p of page?.items ?? []) for (const f of FILTERS) if (f.statuses.includes(p.status)) out[f.id]++;
    return out;
  }, [page]);
  const visible = useMemo(() => {
    const allowed = FILTERS.find((f) => f.id === filter)!.statuses;
    const items = (page?.items ?? []).filter((p) => allowed.includes(p.status));
    return filter === "OPEN" ? items.sort((a, b) => Number(BigInt(b.weightUnits) - BigInt(a.weightUnits))) : items;
  }, [page, filter]);
  const isAdmin = me.data?.user.isAdmin ?? false;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex max-w-2xl flex-col gap-3">
          <h1 className="h1">
            Steer <em>Pyre</em>.
          </h1>
          <p className="body text-ink-2">
            Proposals to change the platform itself, weighted by $PYRE. Hold {formatBps(PLATFORM_PROPOSAL_MIN_HOLD_BPS)} of supply to propose; any holder votes; a proposal is
            backed at {formatBps(PLATFORM_PROPOSAL_QUORUM_BPS)} of supply with each wallet capped at {formatBps(VOTE_WALLET_CAP_BPS)}. Open proposals go stale after{" "}
            {PLATFORM_PROPOSAL_STALE_DAYS} days.
          </p>
        </div>
        <div className="shrink-0">
          {auth.authenticated ? (
            <Button onClick={() => setComposing(true)} disabled={!page?.pyreLaunched}>
              New proposal
            </Button>
          ) : (
            <Button variant="secondary" onClick={auth.signIn}>
              Sign in to vote
            </Button>
          )}
        </div>
      </header>

      {page && !page.pyreLaunched && (
        <div className="rounded-card border border-[color-mix(in_oklab,var(--color-warn)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-warn)_6%,transparent)] px-4 py-3 text-14 text-ink-2">
          <span className="eyebrow mr-2 text-warn">Pre-launch</span>
          $PYRE has not launched yet, so there is no vote weight to count. The board opens for proposals and votes the moment the token exists.
        </div>
      )}

      <Tabs
        name="gov"
        value={filter}
        onChange={setFilter}
        items={FILTERS.map((f) => ({ id: f.id, label: f.label, count: counts[f.id] || undefined }))}
      />

      {q.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28" rounded="card" />
          <Skeleton className="h-28" rounded="card" />
          <Skeleton className="h-28" rounded="card" />
        </div>
      ) : q.isError || !page ? (
        <p className="text-danger">Proposals could not be loaded.</p>
      ) : visible.length === 0 ? (
        <EmptyState
          title={filter === "OPEN" ? "No open proposals" : `Nothing ${FILTERS.find((f) => f.id === filter)!.label.toLowerCase()}`}
          body={filter === "OPEN" ? "Hold enough $PYRE and propose the first change." : "Proposals move here as the roadmap advances."}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((p) => (
            <li key={p.id}>
              <ProposalRow proposal={p} page={page} authed={auth.authenticated} isAdmin={isAdmin} open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)} />
            </li>
          ))}
        </ul>
      )}

      <Compose open={composing} onClose={() => setComposing(false)} page={page} />
    </div>
  );
};

const ProposalRow = ({ proposal: p, page, authed, isAdmin, open, onToggle }: { proposal: ProposalDto; page: ProposalsPage; authed: boolean; isAdmin: boolean; open: boolean; onToggle: () => void }) => {
  const vote = useVote();
  const setStatus = useSetStatus();
  const quorum = BigInt(page.quorumUnits);
  const weight = BigInt(p.weightUnits);
  const progress = quorum > 0n ? Number((weight * 10_000n) / quorum) / 10_000 : 0;
  const s = STATUS[p.status];
  const busy = vote.isPending && vote.variables?.id === p.id;

  return (
    <Card as="article" className={cx(p.backed && p.status === "OPEN" && "border-[color-mix(in_oklab,var(--color-accent)_40%,var(--color-line))]")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <button type="button" onClick={onToggle} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-15 font-medium text-ink">{p.title}</h2>
            <Chip size="sm" tone={s.tone} dot>
              {s.label}
            </Chip>
            {p.backed && p.status === "OPEN" && (
              <Chip size="sm" tone="accent" mono>
                backed
              </Chip>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-12 text-ink-3">
            <Avatar src={p.author.avatarUrl} name={p.author.displayName ?? p.author.wallet ?? "?"} size={16} />
            <span>{p.author.displayName ?? p.author.xHandle ?? "anon"}</span>
            <span aria-hidden>·</span>
            <span className="num">{timeAgo(p.createdAt)}</span>
            <span aria-hidden>·</span>
            <span className="num">{p.comments} comments</span>
          </div>
          <p className={cx("small mt-2 whitespace-pre-line text-ink-2", !open && "line-clamp-2")}>{p.body}</p>
        </button>
        <div className="flex shrink-0 flex-col gap-2 sm:w-44">
          <div className="flex items-baseline justify-between text-12">
            <span className="num text-ink">{p.weightPctOfSupply.toFixed(2)}% of supply</span>
            <span className="num text-ink-3">{p.votes} voters</span>
          </div>
          <Progress value={progress} tone={p.backed ? "accent" : "build"} label="Backing toward quorum" />
          <div className="small text-ink-3">
            {formatTokenUnits(weight, { compact: true })} / {formatTokenUnits(quorum, { compact: true })} $PYRE
          </div>
          {p.status === "OPEN" && authed && (
            <Button
              size="sm"
              variant={p.votedByMe ? "secondary" : "primary"}
              loading={busy}
              onClick={() => vote.mutate({ id: p.id, on: !p.votedByMe }, { onError: (e) => toast.error(isHttpError(e) ? e.message : "Vote failed.") })}
            >
              {p.votedByMe ? "Withdraw vote" : "Back this"}
            </Button>
          )}
        </div>
      </div>

      {p.ownerNote && (
        <div className="mt-3 rounded-control border border-line bg-fill px-3 py-2 text-13 text-ink-2">
          <span className="eyebrow mr-2">Owner note</span>
          {p.ownerNote}
        </div>
      )}

      {open && (
        <div className="mt-4 border-t border-line pt-4">
          <Comments id={p.id} authed={authed} />
          {isAdmin && (
            <form
              className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                setStatus.mutate(
                  { id: p.id, status: fd.get("status") as Status, note: String(fd.get("note") ?? "").trim() || undefined },
                  { onSuccess: () => toast.success("Status updated"), onError: (err) => toast.error(isHttpError(err) ? err.message : "Update failed.") },
                );
              }}
            >
              <Field label="Set status" className="sm:w-44">
                <Select name="status" defaultValue={p.status}>
                  {(Object.keys(STATUS) as Status[]).map((st) => (
                    <option key={st} value={st}>
                      {STATUS[st].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Owner note" className="flex-1">
                <Input name="note" defaultValue={p.ownerNote ?? ""} maxLength={1000} placeholder="Why, and what happens next" />
              </Field>
              <Button type="submit" variant="secondary" loading={setStatus.isPending}>
                Update
              </Button>
            </form>
          )}
        </div>
      )}
    </Card>
  );
};

const Comments = ({ id, authed }: { id: string; authed: boolean }) => {
  const q = useComments(id, true);
  const add = useAddComment(id);
  const [text, setText] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <div className="eyebrow">Discussion</div>
      {q.isPending ? (
        <Skeleton lines={3} />
      ) : (q.data?.items.length ?? 0) === 0 ? (
        <p className="small text-ink-3">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {q.data!.items.map((c) => (
            <li key={c.id} className="flex gap-3">
              <Avatar src={c.author.avatarUrl} name={c.author.displayName ?? c.author.wallet ?? "?"} size={24} />
              <div className="min-w-0">
                <div className="text-12 text-ink-3">
                  {c.author.displayName ?? c.author.xHandle ?? "anon"} · <span className="num">{timeAgo(c.createdAt)}</span>
                </div>
                <p className="small whitespace-pre-line text-ink-2">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {authed && (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            const body = text.trim();
            if (!body) return;
            add.mutate(body, { onSuccess: () => setText(""), onError: (err) => toast.error(isHttpError(err) ? err.message : "Comment failed.") });
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="Add to the discussion" aria-label="Comment" />
          <Button type="submit" variant="secondary" loading={add.isPending} disabled={!text.trim()}>
            Post
          </Button>
        </form>
      )}
    </div>
  );
};

const Compose = ({ open, onClose, page }: { open: boolean; onClose: () => void; page: ProposalsPage | undefined }) => {
  const submit = useSubmitProposal();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const ok = title.trim().length >= 6 && body.trim().length >= 20;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      eyebrow="Governance"
      title="New proposal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ok}
            loading={submit.isPending}
            onClick={() =>
              submit.mutate(
                { title: title.trim(), body: body.trim() },
                {
                  onSuccess: () => {
                    toast.success("Proposal posted");
                    setTitle("");
                    setBody("");
                    onClose();
                  },
                  onError: (e) => toast.error(isHttpError(e) ? e.message : "Could not post the proposal."),
                },
              )
            }
          >
            Post proposal
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="small text-ink-2">
          Submitting needs {page ? formatTokenUnits(page.minHoldUnits, { compact: true }) : "…"} $PYRE ({formatBps(PLATFORM_PROPOSAL_MIN_HOLD_BPS)} of supply) in your wallet. Proposals
          are about Pyre — the platform, the economics, the agent — not about individual coins.
        </p>
        <Field label="Title" required meta={`${title.length}/120`}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Lower the first-build threshold to $25" />
        </Field>
        <Field label="Proposal" required meta={`${body.length}/4000`} hint="What changes, why, and what you expect it to do.">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={4000} />
        </Field>
      </div>
    </Sheet>
  );
};
