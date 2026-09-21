import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { explorerAddressUrl } from "@pyre/shared";
import { useMe } from "../../api/queries.js";
import { useAuth } from "../../auth/useAuth.js";
import { formatEth, formatTokenUnits, formatUsd, shortAddress } from "../../lib/format.js";
import { Address, Avatar, Button, Card, Chip, EthFlow, Skeleton, Tabs, UsdFlow, cx, panelId, tabId } from "../../ui/index.js";
import { DepositTray } from "./DepositTray.js";
import { Launched } from "./Launched.js";
import { Notifications } from "./Notifications.js";
import { Positions } from "./Positions.js";
import { WithdrawTray } from "./WithdrawTray.js";

type Section = "positions" | "launched" | "notifications";

export const MePage = () => {
  const auth = useAuth();
  const me = useMe();
  const navigate = useNavigate();
  const [section, setSection] = useState<Section>("positions");
  const [deposit, setDeposit] = useState(false);
  const [withdraw, setWithdraw] = useState(false);

  useEffect(() => {
    document.title = "Pyre — account";
  }, []);

  const data = me.data;

  // Portfolio value in USD and ETH; the 24h delta is the sum of each position's move.
  const portfolio = useMemo(() => {
    if (!data) return null;
    const valueUsd = data.positions.reduce((s, p) => s + p.valueUsd, 0);
    const delta = data.positions.reduce((s, p) => (p.app.change24hPct == null ? s : s + p.valueUsd - p.valueUsd / (1 + p.app.change24hPct / 100)), 0);
    const price = data.balances.ethPriceUsd;
    const ethBalanceUsd = (Number(BigInt(data.balances.ethWei)) / 1e18) * price;
    const usdgUsd = Number(BigInt(data.balances.usdgUnits)) / 1e6;
    const total = valueUsd + ethBalanceUsd + usdgUsd;
    return { total, valueUsd, delta, deltaPct: valueUsd - delta > 0 ? (delta / (valueUsd - delta)) * 100 : 0, totalEth: price > 0 ? total / price : 0 };
  }, [data]);

  if (!auth.ready || (auth.authenticated && me.isPending)) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <Skeleton className="h-24 w-full max-w-md" rounded="card" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-28" rounded="card" />
          <Skeleton className="h-28" rounded="card" />
        </div>
        <Skeleton className="h-64" rounded="card" />
      </div>
    );
  }

  if (!auth.authenticated || !data) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex max-w-2xl flex-col gap-4">
          <h1 className="h1">
            Your <em>account</em>.
          </h1>
          <p className="body text-ink-2">Balances, positions, the coins you launched, and the share of every coin's remaining supply that grows with each burn.</p>
          <div>
            <Button size="lg" onClick={auth.signIn}>
              Sign in
            </Button>
          </div>
        </header>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <div className="eyebrow mb-2">Custodial wallet</div>
            <h2 className="h3 mb-1">Sign in with Google</h2>
            <p className="small text-ink-2">
              Pyre derives a Robinhood Chain wallet for you and signs on your behalf: one-click stakes, trades, withdrawals. You deposit ETH or USDG to it and can withdraw any
              time. Pyre holds the key; you never see it.
            </p>
          </Card>
          <Card>
            <div className="eyebrow mb-2">External wallet</div>
            <h2 className="h3 mb-1">Sign in with your own wallet</h2>
            <p className="small text-ink-2">
              Prove the address with one signed message. You sign every transaction yourself, in your wallet, on chain 4663. Pyre never holds a key for you. You still get a
              custodial balance for app purchases if you want one.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  const ethWei = BigInt(data.balances.ethWei);
  const usdgUnits = BigInt(data.balances.usdgUnits);
  const up = (portfolio?.delta ?? 0) >= 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Avatar src={data.user.avatarUrl} name={data.user.displayName ?? data.wallet} size={36} />
            <div className="min-w-0">
              <div className="truncate text-15 font-medium text-ink">{data.user.displayName ?? shortAddress(data.wallet, 6)}</div>
              <div className="flex flex-wrap items-center gap-2 text-12 text-ink-3">
                <Address address={data.wallet} chars={6} explorerUrl={explorerAddressUrl(data.wallet)} label={undefined} className="text-12" />
                <Chip size="sm" mono>
                  custodial
                </Chip>
                {data.authWallet && (
                  <Chip size="sm" mono tone="accent">
                    {shortAddress(data.authWallet)} external
                  </Chip>
                )}
                {data.user.isAdmin && (
                  <Chip size="sm" mono tone="build">
                    ops
                  </Chip>
                )}
              </div>
            </div>
          </div>
          <div>
            <div className="eyebrow">Portfolio</div>
            <div className="figure figure-xl text-ink">
              <UsdFlow micros={BigInt(Math.round((portfolio?.total ?? 0) * 1e6))} />
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-3 text-13">
              <span className="num text-ink-2">
                <EthFlow wei={BigInt(Math.round((portfolio?.totalEth ?? 0) * 1e18))} digits={4} />
              </span>
              {portfolio && portfolio.valueUsd > 0 && (
                <span className={cx("num", up ? "text-earn" : "text-burn")}>
                  {up ? "▲" : "▼"} {formatUsd(BigInt(Math.round(Math.abs(portfolio.delta) * 1e6)))} ({Math.abs(portfolio.deltaPct).toFixed(2)}%) 24h
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setDeposit(true)}>
            Deposit
          </Button>
          <Button variant="secondary" onClick={() => setWithdraw(true)} disabled={ethWei === 0n && usdgUnits === 0n}>
            Withdraw
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void auth.signOut();
              navigate("/");
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2" aria-label="Balances">
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="eyebrow">ETH</div>
              <div className="num mt-1 text-22 text-ink">{formatEth(ethWei, { unit: false })}</div>
              <div className="small text-ink-3">≈ {formatUsd(BigInt(Math.round((Number(ethWei) / 1e18) * data.balances.ethPriceUsd * 1e6)))} · gas, stakes, coin buys</div>
            </div>
            <Chip size="sm" mono>
              chain 4663
            </Chip>
          </div>
        </Card>
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="eyebrow">USDG</div>
              <div className="num mt-1 text-22 text-ink">{formatTokenUnits(usdgUnits, { decimals: 6 })}</div>
              <div className="small text-ink-3">Global Dollar · pays for apps, gas-free</div>
            </div>
            <Chip size="sm" mono>
              6 dec
            </Chip>
          </div>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <Tabs
          name="me"
          value={section}
          onChange={setSection}
          items={[
            { id: "positions", label: "Positions", count: data.positions.length },
            { id: "launched", label: "Launched", count: data.launched.length },
            { id: "notifications", label: "Notifications", count: data.notifications.unread || undefined },
          ]}
        />
        <div role="tabpanel" id={panelId("me", section)} aria-labelledby={tabId("me", section)}>
          {section === "positions" && <Positions positions={data.positions} />}
          {section === "launched" && <Launched me={data} />}
          {section === "notifications" && <Notifications />}
        </div>
      </section>

      <DepositTray open={deposit} onClose={() => setDeposit(false)} address={data.wallet} />
      <WithdrawTray open={withdraw} onClose={() => setWithdraw(false)} me={data} />
    </div>
  );
};
