import { useState } from "react";
import type { LaunchDraftDto, MeDto } from "@pyre/shared";
import { decimalToUnits, venueOf } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { formatNative, formatUsd, nativeToNumber } from "../../lib/format.js";
import { Button, Chip, Field, Input, Sheet, toast } from "../../ui/index.js";
import { useTopup } from "./hooks.js";

/** Quick amounts in whole native units; SOL is worth less per unit than ETH, so its chips sit higher. */
const PRESETS: Record<string, readonly string[]> = {
  ETH: ["0.005", "0.01", "0.05", "0.1"],
  SOL: ["0.1", "0.25", "0.5", "1"],
};

/**
 * Top up / relight — the app's native asset (ETH on Robinhood Chain, SOL on Solana) from the
 * matching custodial balance, 100% to the app's build budget. A dormant app relights on the
 * first dollar.
 *
 * Loaded lazily by `Launched`: it is the only sheet on the account page's launched tab, and the
 * page must not pay for the sheet's motion runtime until someone opens it.
 */
export const TopupTray = ({ launch, me, onClose }: { launch: LaunchDraftDto; me: MeDto; onClose: () => void }) => {
  const venue = venueOf(launch);
  const native = venue.native;
  const solana = venue.chain === "solana";
  const [amount, setAmount] = useState(PRESETS[native.symbol]![1]!);
  const topup = useTopup();
  const have = BigInt(solana ? me.balances.solLamports : me.balances.ethWei);
  const priceUsd = solana ? me.balances.solPriceUsd : me.balances.ethPriceUsd;
  let units = 0n;
  try {
    units = amount ? decimalToUnits(amount, native.decimals) : 0n;
  } catch {
    units = -1n;
  }
  const usd = nativeToNumber(units, native) * priceUsd;
  const bad = units <= 0n || units > have;
  const relight = launch.status === "DORMANT";

  return (
    <Sheet
      open
      onClose={onClose}
      eyebrow={`$${launch.ticker} · ${venue.chainLabel}`}
      title={relight ? "Relight the agent" : "Top up the build budget"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={topup.isPending}>
            Cancel
          </Button>
          <Button
            disabled={bad}
            loading={topup.isPending}
            onClick={() =>
              topup.mutate(
                { slug: launch.slug, amount: Number(amount) },
                {
                  onSuccess: () => {
                    toast.success(relight ? `$${launch.ticker} relit` : "Budget topped up", { description: `${formatNative(units, native)} → build budget` });
                    onClose();
                  },
                  onError: (e) => toast.error(isHttpError(e) ? e.message : "Top-up failed."),
                },
              )
            }
          >
            {relight ? "Relight" : "Top up"} {formatNative(units > 0n ? units : 0n, native)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-14 text-ink-2">
          {relight
            ? `The agent stopped because the budget hit zero. ${native.symbol} from your Pyre balance on ${venue.chainLabel} goes 100% to the build budget and the next scheduler pass picks the app back up.`
            : `${native.symbol} from your Pyre balance on ${venue.chainLabel}, 100% to the build budget. The agent spends it on iterations at the metered cost of each job.`}
        </p>
        <Field
          label="Amount"
          meta={<span className="num">Balance {formatNative(have, native)}</span>}
          hint={units > 0n ? `≈ ${formatUsd(BigInt(Math.round(usd * 1e6)))} at today's ${native.symbol} price` : undefined}
          error={units > have ? "More than the balance." : units === -1n ? "Not a number." : undefined}
        >
          <Input mono inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} suffix={native.symbol} invalid={units > have} />
        </Field>
        <div className="flex flex-wrap gap-2">
          {PRESETS[native.symbol]!.map((v) => (
            <Chip key={v} selected={amount === v} onClick={() => setAmount(v)} mono>
              {v} {native.symbol}
            </Chip>
          ))}
        </div>
        <p className="small text-ink-3">Top-ups are not refundable and are not fees: they are a direct contribution to the agent's budget, recorded as a fee event on the coin page.</p>
      </div>
    </Sheet>
  );
};
