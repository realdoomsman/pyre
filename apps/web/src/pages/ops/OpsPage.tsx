import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppDetailDto, OpsDto } from "@pyre/shared";
import { explorerAddressUrl } from "@pyre/shared";
import { api, isHttpError } from "../../api/client.js";
import { useMe } from "../../api/queries.js";
import { useAuth } from "../../auth/useAuth.js";
import { formatEth, formatTokenUnits, formatUsd, timeAgo } from "../../lib/format.js";
import { Address, Button, Card, CardHeader, Chip, EmptyState, Field, Input, Progress, Skeleton, StatusLed, cx, toast, type ChipTone } from "../../ui/index.js";

const opsKey = ["admin", "ops"] as const;

const useOps = (enabled: boolean) =>
  useQuery({ queryKey: opsKey, queryFn: ({ signal }) => api.get<OpsDto>("/v1/admin/ops", signal), enabled, refetchInterval: 30_000 });

const useSetting = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { key: string; value: unknown }) => api.post<unknown>("/v1/admin/settings", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: opsKey }),
  });
};

const useKill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, reason, undo }: { slug: string; reason: string; undo: boolean }) => {
      const app = await api.get<AppDetailDto>(`/v1/apps/${slug}`);
      return api.post<unknown>(`/v1/admin/apps/${app.id}/${undo ? "unkill" : "kill"}`, undo ? {} : { reason });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: opsKey }),
  });
};

const PAUSES: ReadonlyArray<{ key: string; label: string; detail: string }> = [
  { key: "pause_builds", label: "Pause builds", detail: "No new build jobs start. Running jobs finish." },
  { key: "pauseFeeSweep", label: "Pause fee sweeps", detail: "Fees keep accruing on the curve / hook and in escrow; nothing is claimed or split." },
  { key: "pauseBuyback", label: "Pause PYRE burns", detail: "The PYRE_TOKEN ledger keeps accruing; no swaps, no burns." },
];

const ALERT_TONE: Record<OpsDto["alerts"][number]["level"], ChipTone> = { info: "build", warn: "warn", critical: "burn" };

export const OpsPage = () => {
  const auth = useAuth();
  const me = useMe();
  const isAdmin = me.data?.user.isAdmin ?? false;
  const ops = useOps(auth.authenticated && isAdmin);
  const setting = useSetting();
  const kill = useKill();
  const [reason, setReason] = useState("");
  const [slug, setSlug] = useState("");

  useEffect(() => {
    document.title = "Ops — Pyre";
  }, []);

  if (!auth.ready || (auth.authenticated && me.isPending)) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64" rounded="card" />
      </div>
    );
  }

  if (!auth.authenticated || !isAdmin) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <h1 className="h1">Ops</h1>
        <div role="alert" className="max-w-lg rounded-card border border-line bg-surface p-5">
          <div className="eyebrow mb-1">403</div>
          <p className="text-15 text-ink">Operators only.</p>
          <p className="small mt-1 text-ink-2">
            {auth.authenticated ? "This account is not an operator. Nothing here is hidden that matters to users — every number is on the public status and coin pages." : "Sign in with an operator account to see queues, treasury and the switches."}
          </p>
          {!auth.authenticated && (
            <Button variant="secondary" size="sm" className="mt-4" onClick={auth.signIn}>
              Sign in
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (ops.isPending) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64" rounded="card" />
      </div>
    );
  }
  if (ops.isError || !ops.data) return <p className="text-danger">{isHttpError(ops.error) && ops.error.status === 403 ? "Operators only." : "Ops could not be loaded."}</p>;

  const d = ops.data;
  const computeToday = BigInt(d.compute.todayMicros);
  const ceiling = BigInt(d.compute.ceilingMicros);
  const submitKill = (e: FormEvent, undo: boolean) => {
    e.preventDefault();
    if (!slug.trim() || (!undo && reason.trim().length < 3)) return;
    kill.mutate(
      { slug: slug.trim(), reason: reason.trim(), undo },
      {
        onSuccess: () => {
          toast.success(undo ? `${slug} restored` : `${slug} killed`);
          setSlug("");
          setReason("");
        },
        onError: (err) => toast.error(isHttpError(err) ? err.message : "Action failed."),
      },
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Ops</h1>
          <p className="small mt-1 text-ink-3">
            Generated {timeAgo(d.generatedAt)} · block <span className="num">{d.chain.blockNumber.toLocaleString("en-US")}</span> · ETH <span className="num">${d.chain.ethPriceUsd.toFixed(2)}</span>
          </p>
        </div>
        <StatusLed tone={d.chain.rpcOk ? "live" : "error"} label={d.chain.rpcOk ? `RPC ok · chain ${d.chain.chainId}` : "RPC down"} />
      </header>

      {d.alerts.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Alerts">
          {d.alerts.map((a) => (
            <li key={a.code + a.message} className={cx("flex items-start gap-3 rounded-card border px-4 py-3 text-14", a.level === "critical" ? "border-[color-mix(in_oklab,var(--color-burn)_40%,transparent)]" : "border-line")}>
              <Chip size="sm" tone={ALERT_TONE[a.level]} mono>
                {a.level}
              </Chip>
              <span className="text-ink">{a.message}</span>
              {a.href && (
                <a href={a.href} className="ml-auto text-13 text-accent underline underline-offset-2">
                  Open
                </a>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Treasury and queues">
        <Card>
          <div className="eyebrow">Treasury ETH</div>
          <div className="num mt-1 text-22 text-ink">{formatEth(d.treasury.ethWei)}</div>
          <Address address={d.treasury.address} chars={5} explorerUrl={explorerAddressUrl(d.treasury.address)} className="mt-1 text-12" />
        </Card>
        <Card>
          <div className="eyebrow">Treasury USDG</div>
          <div className="num mt-1 text-22 text-ink">{formatTokenUnits(d.treasury.usdgUnits, { decimals: 6 })}</div>
          <div className="small text-ink-3">merchant of record balance</div>
        </Card>
        <Card>
          <div className="eyebrow">Queues</div>
          <div className="num mt-1 text-22 text-ink">
            {d.jobs.queued} <span className="text-14 text-ink-3">queued</span> · {d.jobs.running} <span className="text-14 text-ink-3">running</span>
          </div>
          <div className="small text-ink-3">
            24h: <span className="num text-earn">{d.jobs.succeeded24h} ok</span> · <span className="num text-burn">{d.jobs.failed24h} failed</span>
          </div>
        </Card>
        <Card>
          <div className="eyebrow">Compute today</div>
          <div className="num mt-1 text-22 text-ink">{formatUsd(computeToday, 0)}</div>
          <Progress value={ceiling > 0n ? Number((computeToday * 1000n) / ceiling) / 1000 : 0} tone={computeToday * 10n > ceiling * 8n ? "warn" : "build"} className="mt-2" label="Compute against daily ceiling" />
          <div className="small mt-1 text-ink-3">ceiling {formatUsd(ceiling, 0)}</div>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader eyebrow="Switches" title="Pause" description="Each flag is a PlatformSetting read by the scheduler on its next tick." />
          <ul className="flex flex-col divide-y divide-line">
            {PAUSES.map((p) => {
              const on = d.settings[p.key] === true;
              return (
                <li key={p.key} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <div className="text-14 font-medium text-ink">{p.label}</div>
                    <div className="small text-ink-3">{p.detail}</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={p.label}
                    disabled={setting.isPending}
                    onClick={() => setting.mutate({ key: p.key, value: !on }, { onError: (e) => toast.error(isHttpError(e) ? e.message : "Could not update the setting.") })}
                    className={cx("relative h-6 w-11 shrink-0 rounded-pill border transition-colors duration-(--duration-ui)", on ? "border-warn bg-[color-mix(in_oklab,var(--color-warn)_35%,transparent)]" : "border-line-2 bg-fill")}
                  >
                    <span className={cx("absolute top-0.5 h-4.5 w-4.5 rounded-pill bg-ink transition-[left] duration-(--duration-ui)", on ? "left-[22px]" : "left-0.5")} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card>
          <CardHeader eyebrow="Kill switch" title="Kill or restore an app" description="Builds stop, hosting returns 410, the page says it was removed. The coin is untouched." />
          <form className="flex flex-col gap-3" onSubmit={(e) => submitKill(e, false)}>
            <Field label="Slug">
              <Input mono value={slug} onChange={(e) => setSlug(e.target.value.trim().toLowerCase())} placeholder="deadline-radar" autoComplete="off" />
            </Field>
            <Field label="Reason" hint="Recorded in the audit log and shown on the app page.">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Content policy: impersonation" />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={kill.isPending} disabled={!slug || reason.trim().length < 3}>
                Kill
              </Button>
              <Button type="button" variant="secondary" loading={kill.isPending} disabled={!slug} onClick={(e) => submitKill(e, true)}>
                Restore
              </Button>
            </div>
          </form>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card padding={0}>
          <CardHeader className="px-4 pt-4 sm:px-5 sm:pt-5" eyebrow="Reconcile" title="Ledger vs chain" description="Latest run per check. Drift means the ledger and the chain disagree." />
          {d.reconcile.length === 0 ? (
            <div className="px-4 pb-4 sm:px-5 sm:pb-5">
              <EmptyState title="No reconcile runs yet" body="The runner reports here after its first pass." />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {d.reconcile.map((r) => (
                <li key={r.kind} className="flex items-center justify-between gap-3 px-4 py-2.5 text-13 sm:px-5">
                  <span className="flex items-center gap-2">
                    <StatusLed tone={r.ok ? "live" : "error"} />
                    <span className="num text-ink">{r.kind}</span>
                  </span>
                  <span className="num text-ink-3">
                    {r.checked} checked · <span className={r.drifted > 0 ? "text-burn" : ""}>{r.drifted} drifted</span> · {timeAgo(r.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader eyebrow="Money" title="Flows" />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-13">
            <Kv k="Fees total" v={formatEth(d.money.feesTotalWei)} />
            <Kv k="Fees 24h" v={formatEth(d.money.fees24hWei)} tone="earn" />
            <Kv k="PYRE burns pending" v={String(d.money.pyreBurnsPending)} />
            <Kv k="PYRE burns stuck" v={String(d.money.pyreBurnsStuck)} tone={d.money.pyreBurnsStuck > 0 ? "burn" : undefined} />
            <Kv k="Credit fundings stuck" v={String(d.money.creditFundingsStuck)} tone={d.money.creditFundingsStuck > 0 ? "burn" : undefined} />
            <Kv k="Open flags / reports" v={`${d.flags.open} / ${d.flags.reportsOpen}`} tone={d.flags.open + d.flags.reportsOpen > 0 ? "warn" : undefined} />
          </dl>
          <div className="mt-4 border-t border-line pt-3">
            <div className="eyebrow mb-2">Ledger accounts</div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-12">
              {Object.entries(d.money.ledger).map(([k, v]) => (
                <Kv key={k} k={k} v={formatUsd(BigInt(v))} />
              ))}
            </dl>
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <div className="eyebrow mb-2">Apps by status</div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(d.apps).map(([k, v]) => (
                <Chip key={k} size="sm" mono>
                  {k.toLowerCase()} {v}
                </Chip>
              ))}
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
};

const Kv = ({ k, v, tone }: { k: string; v: string; tone?: "earn" | "burn" | "warn" }) => (
  <div className="flex items-baseline justify-between gap-2">
    <dt className="truncate text-ink-3">{k}</dt>
    <dd className={cx("num shrink-0", tone === "earn" ? "text-earn" : tone === "burn" ? "text-burn" : tone === "warn" ? "text-warn" : "text-ink")}>{v}</dd>
  </div>
);
