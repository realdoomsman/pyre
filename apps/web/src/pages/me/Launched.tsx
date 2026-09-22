import { Suspense, lazy, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { LaunchDraftDto, MeDto } from "@pyre/shared";
import { explorerTxUrl } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { formatEth, formatUsd, timeAgo } from "../../lib/format.js";
import { Address, Avatar, Button, Chip, EmptyState, StatusLed, toast, type ChipTone, type LedTone } from "../../ui/index.js";
import { useClaimLauncher } from "./hooks.js";

// Dynamic on purpose: the tray is this tab's only sheet, and a static import would put the sheet's
// motion runtime in /me's initial graph.
const TopupTray = lazy(async () => ({ default: (await import("./TopupTray.js")).TopupTray }));

const STATUS: Record<LaunchDraftDto["status"], { tone: ChipTone; led: LedTone; label: string }> = {
  DRAFT: { tone: "neutral", led: "build", label: "Drafting brief" },
  SPEC_READY: { tone: "accent", led: "warn", label: "Brief awaiting approval" },
  AWAITING_STAKE: { tone: "accent", led: "warn", label: "Awaiting stake" },
  LAUNCHING: { tone: "build", led: "build", label: "Launching" },
  LAUNCH_GATED: { tone: "warn", led: "warn", label: "Waiting on PONS" },
  LIVE: { tone: "earn", led: "live", label: "Live" },
  DORMANT: { tone: "neutral", led: "idle", label: "Dormant" },
  KILLED: { tone: "burn", led: "error", label: "Killed" },
  FAILED: { tone: "burn", led: "error", label: "Failed" },
};

const RESUMABLE: Partial<Record<LaunchDraftDto["status"], true>> = { DRAFT: true, SPEC_READY: true, AWAITING_STAKE: true, LAUNCHING: true, LAUNCH_GATED: true };

export const Launched = ({ me }: { me: MeDto }) => {
  const navigate = useNavigate();
  const claim = useClaimLauncher();
  const [topup, setTopup] = useState<LaunchDraftDto | null>(null);
  const claimableWei = BigInt(me.claimable.launcherWei);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="eyebrow">Claimable launcher share</div>
          <div className="num text-22 text-ink">{formatEth(claimableWei)}</div>
          <div className="small text-ink-3">{formatUsd(BigInt(me.claimable.launcherMicros))} · 15% of every creator fee your coins earned, paid in ETH to your Pyre wallet.</div>
        </div>
        <Button
          variant="secondary"
          disabled={claimableWei === 0n}
          loading={claim.isPending}
          onClick={() =>
            claim.mutate(undefined, {
              onSuccess: (r) => toast.success(`Claimed ${formatEth(r.wei)}`, { description: "View on Blockscout", action: { label: "Open", onClick: () => window.open(explorerTxUrl(r.txHash), "_blank", "noopener") } }),
              onError: (e) => toast.error(isHttpError(e) ? e.message : "Claim failed."),
            })
          }
        >
          Claim
        </Button>
      </div>

      {me.launched.length === 0 ? (
        <EmptyState
          title="You have not launched a coin"
          body="Launch one and its agent, budget, fees and stake show up here."
          action={
            <Button variant="secondary" size="sm" onClick={() => navigate("/launch")}>
              Launch a coin
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
          {me.launched.map((l) => {
            const s = STATUS[l.status];
            const resumable = RESUMABLE[l.status];
            return (
              <li key={l.id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="flex min-w-0 items-start gap-3">
                  <Avatar src={l.imageUrl} name={l.ticker} size={40} shape="square" className={l.status === "DORMANT" ? "ash" : undefined} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-15 font-medium text-ink">{l.name}</span>
                      <Chip mono size="sm">
                        ${l.ticker}
                      </Chip>
                      <Chip tone={s.tone} size="sm" dot>
                        {s.label}
                      </Chip>
                    </div>
                    <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-12 sm:grid-cols-4">
                      <div>
                        <dt className="eyebrow">Budget</dt>
                        <dd className="num text-ink">{formatUsd(BigInt(l.budgetMicros))}</dd>
                      </div>
                      <div>
                        <dt className="eyebrow">Fees accrued</dt>
                        <dd className="num text-earn">{formatEth(l.feesWei)}</dd>
                      </div>
                      <div>
                        <dt className="eyebrow">Live</dt>
                        <dd className="num text-ink">{l.liveVersion > 0 ? `v${l.liveVersion}` : "not yet"}</dd>
                      </div>
                      <div>
                        <dt className="eyebrow">Stake</dt>
                        <dd className="num text-ink">
                          {l.stakeRefundTx ? (
                            <span className="flex flex-col">
                              refunded <Address address={l.stakeRefundTx} kind="tx" chars={4} explorerUrl={explorerTxUrl(l.stakeRefundTx)} copy={false} />
                            </span>
                          ) : l.stakeTx ? (
                            `${formatEth(l.stakeWei)} escrowed`
                          ) : (
                            "—"
                          )}
                        </dd>
                      </div>
                    </dl>
                    <div className="small mt-1 text-ink-3">
                      {l.status === "KILLED" && l.killedReason ? `Killed: ${l.killedReason}` : l.status === "FAILED" && l.killedReason ? l.killedReason : `${l.liveVersion > 0 ? `v${l.liveVersion} · ` : ""}${timeAgo(l.updatedAt)}`}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  {resumable ? (
                    <Button size="sm" onClick={() => navigate(`/launch?id=${l.id}`)}>
                      Resume launch
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => navigate(`/c/${l.slug}`)}>
                      Coin page
                    </Button>
                  )}
                  {(l.status === "LIVE" || l.status === "DORMANT") && (
                    <Button size="sm" variant={l.status === "DORMANT" ? "primary" : "ghost"} onClick={() => setTopup(l)}>
                      {l.status === "DORMANT" ? "Relight" : "Top up"}
                    </Button>
                  )}
                  {l.status === "LIVE" && <StatusLed tone={s.led} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {topup && (
        <Suspense fallback={null}>
          <TopupTray launch={topup} me={me} onClose={() => setTopup(null)} />
        </Suspense>
      )}
    </div>
  );
};
