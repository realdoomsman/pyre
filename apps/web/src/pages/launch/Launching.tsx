import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { LaunchDraftDto } from "@pyre/shared";
import { venueOf } from "@pyre/shared";
import { formatNative, shortAddress } from "../../lib/format.js";
import { useVenueLinks } from "../../lib/venue.js";
import { Address, Button, Ignition, StatusLed, toast, type IgnitionTick } from "../../ui/index.js";
import { useTxReceipt } from "./hooks.js";

const shareCoin = async (launch: LaunchDraftDto) => {
  const url = `${window.location.origin}/c/${launch.slug}`;
  const burns = launch.chain === "solana" ? `every fee burns $${launch.ticker}` : "every fee burns PYRE";
  const text = `$${launch.ticker} just ignited on Pyre — its creator fees fund an agent that builds ${launch.name}; ${burns}.`;
  try {
    if (navigator.share) {
      await navigator.share({ title: `$${launch.ticker} on Pyre`, text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast.success("Link copied");
  } catch {
    /* user dismissed the share sheet */
  }
};

/**
 * From AWAITING_STAKE (stake posted) through LIVE. Every tick is a fact read from the draft or
 * the chain — the stake receipt, the derived wallet, the launch transaction, its block, the
 * token and curve addresses — so the log is the real sequence, at the real pace.
 */
export const Launching = ({ launch, onRestart }: { launch: LaunchDraftDto; onRestart: () => void }) => {
  const navigate = useNavigate();
  const venue = venueOf(launch);
  const links = useVenueLinks(launch);
  const solana = venue.chain === "solana";
  // The JSON-RPC proxy is EVM-only; on Solana the draft flipping to LIVE is the confirmation.
  const receipt = useTxReceipt(solana ? null : launch.launchTx);
  const [dismissed, setDismissed] = useState(false);

  const ticks = useMemo<IgnitionTick[]>(() => {
    const out: IgnitionTick[] = [];
    if (launch.stakeTx) out.push({ id: "stake", label: `stake ${formatNative(launch.stakeWei, venue.native)}`, detail: shortAddress(launch.stakeTx, 6), tone: "earn" });
    if (launch.walletAddress) out.push({ id: "wallet", label: "app wallet derived", detail: shortAddress(launch.walletAddress, 6) });
    if (launch.status === "LAUNCHING" || launch.launchTx || launch.status === "LIVE")
      out.push(solana ? { id: "fund", label: "treasury funded the create cost + fee float" } : { id: "fund", label: "treasury funded launch fee + gas", detail: "0.0005 ETH" });
    if (launch.launchTx) out.push({ id: "tx", label: solana ? "pump create_v2 sent" : "factory.launchToken sent", detail: shortAddress(launch.launchTx, 6), tone: "build" });
    if (receipt.data)
      out.push({
        id: "block",
        label: `confirmed in block ${parseInt(receipt.data.blockNumber, 16).toLocaleString("en-US")}`,
        detail: receipt.data.status === "0x1" ? "ok" : "reverted",
        tone: receipt.data.status === "0x1" ? "earn" : undefined,
      });
    if (launch.tokenAddress) out.push({ id: "token", label: solana ? "mint created" : "token created", detail: shortAddress(launch.tokenAddress, 6), tone: "build" });
    if (launch.curveAddress) out.push({ id: "curve", label: "curve funded · 1B supply", detail: shortAddress(launch.curveAddress, 6) });
    if (launch.status === "LIVE") out.push({ id: "live", label: "live — fees now fund the agent", tone: "earn" });
    return out;
  }, [launch, receipt.data, venue.native, solana]);

  if (launch.status === "FAILED") {
    return (
      <div className="flex flex-col gap-5">
        <div role="alert" className="rounded-card border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-4 py-4">
          <div className="eyebrow mb-1 text-danger">Launch failed</div>
          <p className="text-15 text-ink">{launch.killedReason ?? "The launch transaction did not complete."}</p>
          <p className="small mt-2 text-ink-2">
            {launch.stakeRefundTx ? (
              <>
                Your stake was refunded: <Address address={launch.stakeRefundTx} kind="tx" chars={6} explorerUrl={links.tx(launch.stakeRefundTx)} className="text-13" />
              </>
            ) : launch.stakeTx ? (
              "Your stake is refunded automatically; the refund transaction will appear here and on your account page."
            ) : (
              "Nothing was charged."
            )}
          </p>
        </div>
        {launch.launchTx && (
          <div className="flex items-center gap-2 text-13 text-ink-2">
            <span className="eyebrow">tx</span>
            <Address address={launch.launchTx} kind="tx" chars={6} explorerUrl={links.tx(launch.launchTx)} />
          </div>
        )}
        <div>
          <Button onClick={onRestart}>Start over with the same idea</Button>
        </div>
      </div>
    );
  }

  if (launch.status === "LAUNCH_GATED") {
    return (
      <div className="flex flex-col gap-5">
        <div role="status" className="rounded-card border border-[color-mix(in_oklab,var(--color-warn)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-warn)_8%,transparent)] px-4 py-4">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="eyebrow text-warn">Waiting on {venue.launchpadLabel}</span>
            <StatusLed tone="warn" label="Retrying" />
          </div>
          <p className="text-15 text-ink">{venue.launchpadLabel} is not accepting launches from this wallet right now.</p>
          <p className="small mt-2 text-ink-2">
            {solana ? (
              <>
                pump.fun's global switch for <span className="num">create_v2</span> is off, or the app wallet could not be funded.
              </>
            ) : (
              <>
                The launch factory answered <span className="num">canLaunch = false</span> for the app wallet.
              </>
            )}{" "}
            Pyre retries automatically on every scheduler pass; you do not need to stay on this page. Your stake stays escrowed and is returned if the launch ultimately fails.
          </p>
        </div>
        {launch.walletAddress && (
          <div className="flex items-center gap-2 text-13 text-ink-2">
            <span className="eyebrow">app wallet</span>
            <Address address={launch.walletAddress} chars={6} explorerUrl={links.address(launch.walletAddress)} />
          </div>
        )}
        <div>
          <Button variant="secondary" onClick={() => navigate("/me")}>
            Track it on your account page
          </Button>
        </div>
      </div>
    );
  }

  const live = launch.status === "LIVE" || launch.status === "DORMANT";
  const show = !dismissed && (live || Boolean(launch.launchTx));

  return (
    <div className="flex flex-col gap-5">
      <div role="status" aria-live="polite" className="flex items-center justify-between rounded-card border border-line bg-mono-bg px-4 py-3">
        <div>
          <div className="eyebrow">launch · ${launch.ticker}</div>
          <p className="text-14 text-ink">
            {live ? `Live on ${venue.chainLabel}.` : launch.launchTx ? "Launch transaction sent — waiting for confirmation." : `Funding the app wallet and sending the ${venue.launchpadLabel} launch.`}
          </p>
        </div>
        <StatusLed tone={live ? "live" : "build"} label={live ? "Live" : "Launching"} />
      </div>
      <ol className="num flex flex-col gap-1 rounded-card border border-line bg-mono-bg p-3 text-12 leading-5">
        {ticks.map((t) => (
          <li key={t.id} className={`flex justify-between gap-3 ${t.tone === "earn" ? "text-earn" : t.tone === "build" ? "text-build" : "text-ink-2"}`}>
            <span>{t.label}</span>
            {t.detail && <span>{t.detail}</span>}
          </li>
        ))}
        {!live && (
          <li className="animate-blink text-build" aria-hidden>
            ▍
          </li>
        )}
      </ol>
      {live && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => navigate(`/c/${launch.slug}`)}>Open coin page</Button>
          <Button variant="secondary" onClick={() => void shareCoin(launch)}>
            Share
          </Button>
          {launch.tokenAddress && (
            <Button variant="ghost" href={venue.launchpadUrl(launch.tokenAddress)} target="_blank" rel="noreferrer noopener">
              View on {venue.launchpadLabel} ↗
            </Button>
          )}
        </div>
      )}
      {launch.launchTx && (
        <Ignition
          open={show}
          ticker={launch.ticker}
          name={launch.name}
          txHash={launch.launchTx}
          explorerUrl={links.tx(launch.launchTx)}
          ticks={ticks}
          status={live ? "confirmed" : "pending"}
          onClose={() => setDismissed(true)}
          action={
            live ? (
              <>
                <Button onClick={() => navigate(`/c/${launch.slug}`)}>Open coin page</Button>
                <Button variant="secondary" onClick={() => void shareCoin(launch)}>
                  Share
                </Button>
                {launch.tokenAddress && (
                  <Button variant="ghost" href={venue.launchpadUrl(launch.tokenAddress)} target="_blank" rel="noreferrer noopener">
                    {venue.launchpadLabel} ↗
                  </Button>
                )}
              </>
            ) : undefined
          }
        />
      )}
      {live && (
        <p className="small text-ink-3">
          Prefer the in-page view? <Link to={`/c/${launch.slug}`} className="text-accent underline underline-offset-2">Go to the coin</Link>.
        </p>
      )}
    </div>
  );
};
