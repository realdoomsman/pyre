import { useMemo, useState } from "react";
import type { AppDetailDto, BuybackDto } from "@pyre/shared";
import { explorerTx } from "../../env.js";
import { formatEth, formatPct, formatTokenUnits, timeAgo } from "../../lib/format.js";
import { Card, CardHeader, Chip, EthFlow, GraduationRing, Progress, SupplyKiln, cx } from "../../ui/index.js";

const PHASE_COPY: Record<number, { title: string; body: string }> = {
  0: { title: "On the curve", body: "Every buy raises the price along the PONS bonding curve. At 4.2 ETH the curve closes and liquidity moves to a Uniswap v4 pool." },
  1: { title: "Sweeping", body: "The curve has closed; PONS is moving liquidity into the Uniswap v4 pool." },
  2: { title: "Graduated · trading on Uniswap v4", body: "The curve raised its 4.2 ETH. Trades now clear on the v4 pool with a 1% hook fee that keeps funding the agent." },
  3: { title: "Rescued", body: "PONS rescued this launch; trading is paused on the curve." },
};

/** Ring + bar toward 4.2 ETH, with the phase spelled out. */
export const GraduationCard = ({ app }: { app: AppDetailDto }) => {
  const threshold = BigInt(app.graduationThresholdWei);
  const graduated = app.phase >= 2;
  const raised = graduated ? threshold : (threshold * BigInt(Math.round(app.progress * 10_000))) / 10_000n;
  const copy = PHASE_COPY[app.phase] ?? PHASE_COPY[0]!;
  return (
    <Card as="section" aria-label="Graduation">
      <div className="flex items-start gap-4">
        <GraduationRing progress={app.progress} graduated={graduated} size={56} stroke={3}>
          <span className={cx("num grid h-full w-full place-items-center text-12 font-medium", graduated ? "text-earn" : "text-ink")}>
            {graduated ? "✓" : `${Math.round(app.progress * 100)}%`}
          </span>
        </GraduationRing>
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Graduation</div>
          <h3 className="mt-0.5 text-15 font-medium text-ink">{copy.title}</h3>
          <div className="num mt-1 text-13 text-ink-2">
            <EthFlow wei={raised} digits={3} /> <span className="text-ink-3">of {formatEth(threshold, { digits: 1 })} raised</span>
          </div>
        </div>
      </div>
      <Progress value={app.progress} tone={graduated ? "earn" : "heat"} size="md" className="mt-4" label="Curve progress" />
      <p className="small mt-3 text-ink-3">{copy.body}</p>
      {graduated && app.poolId && (
        <div className="num mt-2 truncate text-12 text-ink-3" title={app.poolId}>
          pool {app.poolId.slice(0, 10)}…{app.poolId.slice(-6)}
        </div>
      )}
    </Card>
  );
};

const LAYERS = 12;

/**
 * Supply Kiln. Twelve layers of supply; burns hollow them from the top.
 * Hovering a hollowed layer names the burn that took it.
 */
export const KilnCard = ({ app, buybacks }: { app: AppDetailDto; buybacks: ReadonlyArray<BuybackDto> }) => {
  const [hover, setHover] = useState<number | null>(null);
  const burned = app.burnedPct / 100;

  // Oldest first with the running burned fraction after each, so a layer maps to the burn that crossed it.
  const timeline = useMemo(() => {
    const done = buybacks.filter((b) => b.status === "BURNED").slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    let cum = 0;
    return done.map((b) => {
      cum += b.burnedPctOfSupply / 100;
      return { buyback: b, cumulative: cum };
    });
  }, [buybacks]);

  const hollowCount = Math.floor(burned * LAYERS + 1e-9);
  const hovered = hover !== null && hover >= LAYERS - hollowCount ? timeline.find((t) => t.cumulative >= (LAYERS - hover) / LAYERS) ?? null : null;
  const last = timeline[timeline.length - 1]?.buyback ?? null;

  return (
    <Card as="section" aria-label="Supply kiln">
      <CardHeader
        eyebrow="Supply kiln"
        title={`${formatPct(burned, 3)} burned`}
        description={`${formatTokenUnits(app.burnedUnits)} of 1.00B tokens gone for good`}
        actions={
          <Chip tone="burn" size="sm" mono>
            {timeline.length} burns
          </Chip>
        }
      />
      <div className="flex items-start gap-4">
        <SupplyKiln burnedFraction={burned} layers={LAYERS} width={140} label={null} onLayerHover={setHover} />
        <div className="min-w-0 flex-1 text-13">
          {hovered ? (
            <div className="rounded-control border border-line bg-canvas/50 p-3 animate-fade-in">
              <div className="eyebrow text-burn">Burn · {timeAgo(hovered.buyback.createdAt)}</div>
              <div className="num mt-1 text-ink">{formatTokenUnits(hovered.buyback.tokensBurnedUnits)} tokens</div>
              <div className="num text-ink-2">{formatEth(hovered.buyback.ethWei)} of revenue</div>
              {hovered.buyback.burnTx && (
                <a href={explorerTx(hovered.buyback.burnTx)} target="_blank" rel="noreferrer" className="num mt-1 inline-block text-12 text-accent hover:underline">
                  burn tx {hovered.buyback.burnTx.slice(0, 10)}…
                </a>
              )}
            </div>
          ) : (
            <div className="text-ink-2">
              <p>Each layer is {formatPct(1 / LAYERS, 1)} of supply. Burned layers go hollow; hover one to see the burn that took it.</p>
              {last ? (
                <p className="num mt-2 text-12 text-ink-3">
                  last burn {timeAgo(last.createdAt)} · {formatTokenUnits(last.tokensBurnedUnits)} tokens
                </p>
              ) : (
                <p className="num mt-2 text-12 text-ink-3">no burns yet · the first fires once app revenue reaches $5</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};
