import { useEffect } from "react";
import { useStats, useStatus } from "../../api/queries.js";
import { env } from "../../env.js";
import { formatCount, formatDuration, formatEth, formatUsdCompact } from "../../lib/format.js";
import { Card, Chip, Skeleton, StatusLed, cx } from "../../ui/index.js";

const Service = ({ name, ok, latencyMs, detail }: { name: string; ok: boolean | undefined; latencyMs?: number; detail?: string }) => (
  <li className="flex items-center gap-3 py-2.5">
    <StatusLed tone={ok === undefined ? "idle" : ok ? "live" : "error"} />
    <span className="text-14 text-ink">{name}</span>
    {detail && <span className="num text-12 text-ink-3">{detail}</span>}
    <span className={cx("num ml-auto text-12", ok === false ? "text-burn" : "text-ink-3")}>{ok === undefined ? "checking" : ok ? `${latencyMs ?? 0} ms` : "down"}</span>
  </li>
);

const Figure = ({ label, value, tone }: { label: string; value: string; tone?: "earn" | "burn" | "build" }) => (
  <div>
    <div className="eyebrow">{label}</div>
    <div className={cx("figure figure-md mt-1", tone === "earn" ? "text-earn" : tone === "burn" ? "text-burn" : tone === "build" ? "text-build" : "text-ink")}>{value}</div>
  </div>
);

/** Public status: is the platform up, and what has it done. Read-only. */
export const Status = () => {
  const status = useStatus();
  const stats = useStats();

  useEffect(() => {
    document.title = "Pyre — status";
  }, []);

  const s = status.data;
  const ok = status.isSuccess && s?.ok === true;
  const down = status.isError || (status.isSuccess && !s?.ok);
  const queues = s ? Object.entries(s.services.queues.depths) : [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header>
        <h1 className="display text-36 sm:text-48">
          status, <em>measured</em>
        </h1>
        <p className="body mt-2 text-ink-2">service probes and the network's totals. nothing to sign — this page only reports.</p>
      </header>

      <Card padding="md" as="section" aria-labelledby="svc-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <StatusLed tone={status.isPending ? "idle" : ok ? "live" : "error"} />
            <div>
              <h2 id="svc-title" className="text-15 font-medium text-ink">
                pyre api
              </h2>
              <p className="small text-ink-2">{status.isPending ? "checking…" : ok ? "all services answering" : down ? (status.error?.message ?? "a service is not answering") : "degraded"}</p>
            </div>
          </div>
          <Chip tone={ok ? "earn" : down ? "burn" : "neutral"} mono dot>
            {status.isPending ? "checking" : ok ? "operational" : "disrupted"}
          </Chip>
        </div>
        <ul className="mt-4 divide-y divide-line border-t border-line">
          <Service name="postgres" ok={s?.services.db.ok} latencyMs={s?.services.db.latencyMs} />
          <Service name="redis" ok={s?.services.redis.ok} latencyMs={s?.services.redis.latencyMs} />
          <Service name="rpc · robinhood chain" ok={s?.services.rpc.ok} latencyMs={s?.services.rpc.latencyMs} detail={s ? `block ${s.services.rpc.blockNumber.toLocaleString("en-US")}` : undefined} />
          <Service name="queues" ok={s?.services.queues.ok} detail={queues.length ? `${queues.reduce((n, [, d]) => n + d.active, 0)} active · ${queues.reduce((n, [, d]) => n + d.failed, 0)} failed` : undefined} />
        </ul>
        {s && (
          <p className="num mt-3 text-12 text-ink-3">
            v{s.version} · up {formatDuration(s.uptimeSec * 1000)} · chain {s.chain.chainId} · eth ${s.chain.ethPriceUsd.toFixed(2)} · explorer {env.explorerUrl.replace(/^https?:\/\//, "")}
          </p>
        )}
      </Card>

      <Card padding="md" as="section" aria-labelledby="net-title">
        <h2 id="net-title" className="eyebrow">
          network
        </h2>
        {stats.isPending ? (
          <Skeleton className="mt-3 h-24 w-full" />
        ) : stats.isError ? (
          <p role="alert" className="small mt-3 text-burn">
            {stats.error.message}
          </p>
        ) : stats.data ? (
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            <Figure label="apps live" value={formatCount(stats.data.appsLive)} tone="earn" />
            <Figure label="building" value={formatCount(stats.data.appsBuilding)} tone="build" />
            <Figure label="apps total" value={formatCount(stats.data.appsTotal)} />
            <Figure label="buybacks" value={formatCount(stats.data.buybacksCount)} />
            <Figure label="revenue" value={formatUsdCompact(stats.data.revenueTotalMicros)} tone="earn" />
            <Figure label="fees claimed" value={formatEth(stats.data.feesTotalWei)} />
            <Figure label="eth burned" value={formatEth(stats.data.burnedEthWei)} tone="burn" />
            <Figure label="agent-hours today" value={stats.data.agentHoursToday.toFixed(1)} />
          </div>
        ) : null}
      </Card>
    </div>
  );
};
