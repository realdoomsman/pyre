import { useState, type FormEvent } from "react";
import type { AppDetailDto, BountyDto } from "@pyre/shared";
import { useAuth } from "../../../auth/useAuth.js";
import { TxLink } from "../../../components/TxLink.js";
import { formatEth, timeAgo } from "../../../lib/format.js";
import { Avatar, Button, Chip, EmptyState, Field, Input, Skeleton, Textarea, toast, cx, type ChipTone } from "../../../ui/index.js";
import { useBounties, useClaimBounty, useCreateBounty } from "../queries.js";
import { describeError } from "../trade.js";

const STATUS: Record<BountyDto["status"], { label: string; tone: ChipTone }> = {
  OPEN: { label: "open", tone: "earn" },
  CLAIMED: { label: "claimed", tone: "build" },
  PAYING: { label: "paying", tone: "build" },
  PAID: { label: "paid", tone: "neutral" },
  CANCELLED: { label: "cancelled", tone: "neutral" },
};

const MIN_ETH = 0.001;

/** ETH bounties escrowed by holders for contributors; paid on a merged PR. */
export const BountiesTab = ({ app }: { app: AppDetailDto }) => {
  const auth = useAuth();
  const bounties = useBounties(app.slug);
  const create = useCreateBounty(app.slug);
  const claim = useClaimBounty(app.slug);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [eth, setEth] = useState("0.01");
  const [claiming, setClaiming] = useState<{ id: string; pr: string } | null>(null);

  const items = bounties.data?.items ?? [];
  const ethNum = Number(eth);
  const valid = title.trim().length >= 4 && description.trim().length >= 10 && Number.isFinite(ethNum) && ethNum >= MIN_ETH;

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    try {
      await create.mutateAsync({ title: title.trim(), description: description.trim(), eth: ethNum });
      setTitle("");
      setDescription("");
      toast.success("Bounty posted", { description: `${eth} ETH escrowed from your Pyre wallet.` });
    } catch (err) {
      toast.error("Could not post bounty", { description: describeError(err) });
    }
  };

  const onClaim = async (e: FormEvent) => {
    e.preventDefault();
    if (!claiming) return;
    const pr = Number(claiming.pr);
    if (!Number.isInteger(pr) || pr <= 0) return;
    try {
      await claim.mutateAsync({ id: claiming.id, prNumber: pr });
      setClaiming(null);
      toast.success("Claim submitted", { description: `PR #${pr} will pay out once merged.` });
    } catch (err) {
      toast.error("Claim failed", { description: describeError(err) });
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-3">
        <div className="num flex flex-wrap items-center gap-2 text-12 text-ink-3">
          <Chip size="sm" mono tone="earn">
            {app.bounties.open} open · {formatEth(app.bounties.openWei)}
          </Chip>
          {app.socials.repoUrl && (
            <a href={app.socials.repoUrl} target="_blank" rel="noreferrer" className="ml-auto hover:text-ink">
              open a PR on the repo ↗
            </a>
          )}
        </div>
        {bounties.isPending ? (
          <Skeleton lines={6} />
        ) : items.length === 0 ? (
          <EmptyState title="No bounties yet" body="Escrow ETH for a feature you want and a contributor gets paid when their PR merges." />
        ) : (
          <ol className="divide-y divide-line rounded-card border border-line">
            {items.map((b) => (
              <li key={b.id} className={cx("p-3", (b.status === "CANCELLED" || b.status === "PAID") && "ash")}>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={STATUS[b.status].tone} size="sm" mono>
                    {STATUS[b.status].label}
                  </Chip>
                  <span className="num text-15 font-medium text-ink">{formatEth(b.wei)}</span>
                  <span className="num ml-auto text-12 text-ink-3">{timeAgo(b.createdAt)}</span>
                </div>
                <h4 className="mt-1.5 text-14 font-medium text-ink">{b.title}</h4>
                <p className="small mt-0.5 whitespace-pre-wrap break-words text-ink-2">{b.description}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-12 text-ink-3">
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar src={b.author.avatarUrl} name={b.author.displayName ?? "holder"} size={14} /> {b.author.displayName ?? "anonymous"}
                  </span>
                  {b.claimant && (
                    <span>
                      claimed by {b.claimant.displayName ?? "a contributor"}
                      {b.prNumber && ` · PR #${b.prNumber}`}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    escrow <TxLink hash={b.escrowTx} chars={3} copy={false} />
                  </span>
                  {b.payoutTx && (
                    <span className="inline-flex items-center gap-1">
                      payout <TxLink hash={b.payoutTx} chars={3} copy={false} />
                    </span>
                  )}
                  {b.status === "OPEN" && auth.authenticated && (
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setClaiming({ id: b.id, pr: "" })}>
                      Claim with a PR
                    </Button>
                  )}
                </div>
                {claiming?.id === b.id && (
                  <form onSubmit={onClaim} className="mt-2 flex items-end gap-2 animate-rise">
                    <Field label="PR number" className="flex-1">
                      <Input mono inputMode="numeric" placeholder="42" value={claiming.pr} onChange={(e) => setClaiming({ id: b.id, pr: e.target.value })} prefix="#" />
                    </Field>
                    <Button type="submit" variant="primary" size="md" loading={claim.isPending}>
                      Claim
                    </Button>
                    <Button type="button" variant="ghost" size="md" onClick={() => setClaiming(null)}>
                      Cancel
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <form onSubmit={onCreate} className="flex h-fit flex-col gap-3 rounded-card border border-line bg-surface p-4">
        <div>
          <div className="eyebrow">Post a bounty</div>
          <p className="small mt-1 text-ink-2">ETH is escrowed from your Pyre wallet and paid to whoever merges the PR.</p>
        </div>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Dark mode" maxLength={80} disabled={!auth.authenticated} />
        </Field>
        <Field label="What done looks like">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Acceptance criteria, links, screenshots…" maxLength={2000} disabled={!auth.authenticated} />
        </Field>
        <Field label="Reward" hint={`minimum ${MIN_ETH} ETH`}>
          <Input mono inputMode="decimal" value={eth} onChange={(e) => setEth(e.target.value)} suffix="ETH" disabled={!auth.authenticated} />
        </Field>
        {auth.authenticated ? (
          <Button type="submit" variant="primary" disabled={!valid} loading={create.isPending}>
            Escrow {Number.isFinite(ethNum) ? eth : "—"} ETH
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={auth.signIn}>
            Sign in to post
          </Button>
        )}
      </form>
    </div>
  );
};
