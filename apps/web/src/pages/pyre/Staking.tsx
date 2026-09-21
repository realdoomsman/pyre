import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PyrePageDto, PyreStakeDto } from "@pyre/shared";
import { decimalToUnits, explorerTxUrl } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { flatPages, useApps } from "../../api/queries.js";
import { useAuth } from "../../auth/useAuth.js";
import { formatEth, formatTokenUnits, formatUsd, timeAgo } from "../../lib/format.js";
import { Address, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, toast, type Column } from "../../ui/index.js";
import { useClaimStaker, useStakePyre, useUnstakePyre } from "./hooks.js";

/**
 * Stake $PYRE to an app: the app gets scheduler priority, the staker gets a slice of that
 * app's launcher-equivalent fee stream. Paid for a service, never for holding.
 */
export const StakeForm = ({ page }: { page: PyrePageDto }) => {
  const auth = useAuth();
  const apps = useApps("trending");
  const stake = useStakePyre();
  const [appId, setAppId] = useState("");
  const [amount, setAmount] = useState("");
  const units = BigInt(page.viewer?.units ?? "0");
  let want = 0n;
  try {
    want = amount ? decimalToUnits(amount, 18) : 0n;
  } catch {
    want = -1n;
  }
  const candidates = flatPages(apps.data?.pages).filter((a) => a.status === "LIVE" || a.status === "DORMANT");

  if (!auth.authenticated) {
    return (
      <Card>
        <CardHeader eyebrow="Stake" title="Stake $PYRE to an app" description="Sign in to stake. Stakers give an app build priority and earn a slice of its fee stream." />
        <Button variant="secondary" size="sm" onClick={auth.signIn}>
          Sign in
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader eyebrow="Stake" title="Stake $PYRE to an app" actions={<span className="num text-13 text-ink-2">{formatTokenUnits(units, { compact: true })} available</span>} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-end">
        <Field label="App">
          <Select value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">Choose an app…</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · ${a.ticker}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount" error={want > units ? "More than you hold." : want === -1n ? "Not a number." : undefined}>
          <Input mono inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" suffix="PYRE" invalid={want > units} />
        </Field>
        <Button
          disabled={!appId || want <= 0n || want > units}
          loading={stake.isPending}
          onClick={() =>
            stake.mutate(
              { appId, amount: Number(amount) },
              {
                onSuccess: (s) => {
                  toast.success(`Staked ${formatTokenUnits(s.units, { compact: true })} $PYRE to $${s.appTicker}`);
                  setAmount("");
                },
                onError: (e) => toast.error(isHttpError(e) ? e.message : "Stake failed."),
              },
            )
          }
        >
          Stake
        </Button>
      </div>
      <p className="small mt-3 text-ink-3">Staked tokens stay in your custodial wallet's ledger and come back in full when you unstake. Earnings accrue in USD and are paid in ETH on claim.</p>
    </Card>
  );
};

export const MyStakes = ({ page }: { page: PyrePageDto }) => {
  const unstake = useUnstakePyre();
  const claim = useClaimStaker();
  const navigate = useNavigate();
  const viewer = page.viewer;
  if (!viewer) return null;
  const active = viewer.stakes.filter((s) => !s.withdrawnAt);
  const earned = BigInt(viewer.earnedMicros);

  const columns: Column<PyreStakeDto>[] = [
    {
      key: "app",
      header: "App",
      render: (s) => (
        <span>
          <span className="block text-14 text-ink">{s.appName}</span>
          <span className="num block text-12 text-ink-3">${s.appTicker}</span>
        </span>
      ),
    },
    { key: "units", header: "Staked", numeric: true, render: (s) => formatTokenUnits(s.units, { compact: true }) },
    { key: "earned", header: "Earned", numeric: true, render: (s) => <span className="text-earn">{formatUsd(BigInt(s.earnedMicros))}</span> },
    { key: "since", header: "Since", numeric: true, collapse: true, render: (s) => timeAgo(s.createdAt) },
    {
      key: "tx",
      header: "Deposit",
      collapse: true,
      render: (s) => <Address address={s.depositTx} kind="tx" chars={4} explorerUrl={explorerTxUrl(s.depositTx)} copy={false} />,
    },
    {
      key: "actions",
      header: "",
      numeric: true,
      render: (s) => (
        <Button
          variant="ghost"
          size="sm"
          loading={unstake.isPending && unstake.variables === s.id}
          onClick={(e) => {
            e.stopPropagation();
            unstake.mutate(s.id, {
              onSuccess: () => toast.success(`Unstaked from $${s.appTicker}`),
              onError: (err) => toast.error(isHttpError(err) ? err.message : "Unstake failed."),
            });
          }}
        >
          Unstake
        </Button>
      ),
    },
  ];

  return (
    <Card padding={0}>
      <CardHeader
        className="px-4 pt-4 sm:px-5 sm:pt-5"
        eyebrow="Your stakes"
        title={`${formatTokenUnits(viewer.stakedUnits, { compact: true })} staked`}
        description={earned > 0n ? `${formatUsd(earned)} earned, claimable in ETH.` : "Earnings show up here as the apps you back earn fees."}
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={earned < 1_000_000n}
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
        }
      />
      {active.length === 0 ? (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <EmptyState title="No active stakes" body="Stake to an app above to give it build priority." />
        </div>
      ) : (
        <Table columns={columns} rows={active} rowKey={(s) => s.id} onRowClick={(s) => navigate(`/c/${s.appSlug}`)} caption="Your $PYRE stakes" />
      )}
    </Card>
  );
};

export const TopStakes = ({ page }: { page: PyrePageDto }) => {
  const navigate = useNavigate();
  const rows = page.topStakes;
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "app",
      header: "App",
      render: (r) => (
        <span>
          <span className="block text-14 text-ink">{r.appName}</span>
          <span className="num block text-12 text-ink-3">${r.appTicker}</span>
        </span>
      ),
    },
    { key: "units", header: "Staked", numeric: true, render: (r) => formatTokenUnits(r.units, { compact: true }) },
    { key: "stakers", header: "Stakers", numeric: true, render: (r) => r.stakers.toLocaleString("en-US") },
  ];
  return (
    <Card padding={0}>
      <CardHeader className="px-4 pt-4 sm:px-5 sm:pt-5" eyebrow="Priority" title="Most staked apps" description={`${page.stakes.stakers.toLocaleString("en-US")} stakers · ${formatTokenUnits(page.stakes.totalUnits, { compact: true })} $PYRE`} />
      {rows.length === 0 ? (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <EmptyState title="Nothing staked yet" body="The first stakes decide which agents get scheduler priority." />
        </div>
      ) : (
        <Table columns={columns} rows={rows} rowKey={(r) => r.appId} onRowClick={(r) => navigate(`/c/${r.appSlug}`)} caption="Most staked apps" />
      )}
    </Card>
  );
};
