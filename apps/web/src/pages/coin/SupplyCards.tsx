import type { AppDetailDto, Launchpad } from "@pyre/shared";
import { venueOf } from "@pyre/shared";
import { formatNative } from "../../lib/format.js";
import { Card, GraduationRing, NativeFlow, Progress, cx } from "../../ui/index.js";

const PHASE_COPY: Record<Launchpad, Record<number, { title: string; body: string }>> = {
  pons_v2: {
    0: { title: "On the curve", body: "Every buy raises the price along the pons bonding curve. At 4.2 ETH the curve closes and liquidity moves to a Uniswap v4 pool." },
    1: { title: "Sweeping", body: "The curve has closed; pons is moving liquidity into the Uniswap v4 pool." },
    2: { title: "Graduated · trading on Uniswap v4", body: "The curve raised its 4.2 ETH. Trades now clear on the v4 pool with a 1% hook fee that keeps funding the agent." },
    3: { title: "Rescued", body: "pons rescued this launch; trading is paused on the curve." },
  },
  pump_fun: {
    0: { title: "On the curve", body: "Every buy raises the price along the pump.fun bonding curve. When the curve sells out, pump.fun moves liquidity to a PumpSwap pool." },
    1: { title: "Migrating", body: "The curve is complete; pump.fun is moving liquidity into the PumpSwap pool." },
    2: { title: "Graduated · trading on PumpSwap", body: "The curve sold out. Trades now clear on the PumpSwap pool, which keeps paying the creator wallet a tiered share that funds the agent." },
    3: { title: "Paused", body: "Trading is paused on the curve." },
  },
};

/** Ring + bar toward graduation, with the phase spelled out. */
export const GraduationCard = ({ app }: { app: AppDetailDto }) => {
  const venue = venueOf(app);
  const threshold = BigInt(app.graduationThresholdWei);
  const graduated = app.phase >= 2;
  const raised = graduated ? threshold : (threshold * BigInt(Math.round(app.progress * 10_000))) / 10_000n;
  const copy = PHASE_COPY[venue.launchpad][app.phase] ?? PHASE_COPY[venue.launchpad][0]!;
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
          <h2 className="mt-0.5 text-15 font-medium text-ink">{copy.title}</h2>
          <div className="num mt-1 text-13 text-ink-2">
            <NativeFlow units={raised} native={venue.native} digits={3} /> <span className="text-ink-3">of {formatNative(threshold, venue.native, { digits: 1 })} raised</span>
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
