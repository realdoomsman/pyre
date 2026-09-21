import { useState } from "react";
import type { LaunchDraftDto, MeDto } from "@pyre/shared";
import { decimalToUnits } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { formatEth, formatUsd } from "../../lib/format.js";
import { Button, Chip, Field, Input, Sheet, toast } from "../../ui/index.js";
import { useTopup } from "./hooks.js";

/**
 * Top up / relight: ETH from the custodial balance, 100% to the app's build budget. A dormant
 * app relights on the first dollar.
 *
 * Loaded lazily by `Launched`: it is the only sheet on the account page's launched tab, and the
 * page must not pay for the sheet's motion runtime until someone opens it.
 */
export const TopupTray = ({ launch, me, onClose }: { launch: LaunchDraftDto; me: MeDto; onClose: () => void }) => {
  const [amount, setAmount] = useState("0.01");
  const topup = useTopup();
  const have = BigInt(me.balances.ethWei);
  let wei = 0n;
  try {
    wei = amount ? decimalToUnits(amount, 18) : 0n;
  } catch {
    wei = -1n;
  }
  const usd = (Number(wei) / 1e18) * me.balances.ethPriceUsd;
  const bad = wei <= 0n || wei > have;
  const relight = launch.status === "DORMANT";

  return (
    <Sheet
      open
      onClose={onClose}
      eyebrow={`$${launch.ticker}`}
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
                { slug: launch.slug, eth: Number(amount) },
                {
                  onSuccess: () => {
                    toast.success(relight ? `$${launch.ticker} relit` : "Budget topped up", { description: `${formatEth(wei)} → build budget` });
                    onClose();
                  },
                  onError: (e) => toast.error(isHttpError(e) ? e.message : "Top-up failed."),
                },
              )
            }
          >
            {relight ? "Relight" : "Top up"} {formatEth(wei > 0n ? wei : 0n)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-14 text-ink-2">
          {relight
            ? "The agent stopped because the budget hit zero. ETH from your Pyre balance goes 100% to the build budget and the next scheduler pass picks the app back up."
            : "ETH from your Pyre balance, 100% to the build budget. The agent spends it on iterations at the metered cost of each job."}
        </p>
        <Field
          label="Amount"
          meta={<span className="num">Balance {formatEth(have)}</span>}
          hint={wei > 0n ? `≈ ${formatUsd(BigInt(Math.round(usd * 1e6)))} at today's ETH price` : undefined}
          error={wei > have ? "More than the balance." : wei === -1n ? "Not a number." : undefined}
        >
          <Input mono inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} suffix="ETH" invalid={wei > have} />
        </Field>
        <div className="flex flex-wrap gap-2">
          {["0.005", "0.01", "0.05", "0.1"].map((v) => (
            <Chip key={v} selected={amount === v} onClick={() => setAmount(v)} mono>
              {v} ETH
            </Chip>
          ))}
        </div>
        <p className="small text-ink-3">Top-ups are not refundable and are not fees: they are a direct contribution to the agent's budget, recorded as a fee event on the coin page.</p>
      </div>
    </Sheet>
  );
};
