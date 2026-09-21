import { useState } from "react";
import type { MeDto } from "@pyre/shared";
import { WITHDRAW_DAILY_CAP_USD, decimalToUnits, USDG_DECIMALS } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { formatEth, formatTokenUnits, formatUsd } from "../../lib/format.js";
import { Button, Field, Input, Sheet, Tabs, toast } from "../../ui/index.js";
import { useWithdraw } from "./hooks.js";

type Asset = "ETH" | "USDG";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface Props {
  open: boolean;
  onClose: () => void;
  me: MeDto;
}

export const WithdrawTray = ({ open, onClose, me }: Props) => {
  const [asset, setAsset] = useState<Asset>("ETH");
  const [to, setTo] = useState(me.authWallet ?? "");
  const [amount, setAmount] = useState("");
  const withdraw = useWithdraw();

  const ethWei = BigInt(me.balances.ethWei);
  const usdgUnits = BigInt(me.balances.usdgUnits);
  const available = asset === "ETH" ? ethWei : usdgUnits;
  const decimals = asset === "ETH" ? 18 : USDG_DECIMALS;
  let units = 0n;
  try {
    units = amount ? decimalToUnits(amount, decimals) : 0n;
  } catch {
    units = -1n;
  }
  const amountNumber = Number(amount);
  const tooMuch = units > available;
  const bad = units <= 0n || tooMuch || !Number.isFinite(amountNumber);
  const toOk = ADDRESS.test(to.trim());
  const remainingUsd = Number(BigInt(me.withdrawRemainingMicros)) / 1e6;
  const usdValue = asset === "ETH" ? (Number(units) / 1e18) * me.balances.ethPriceUsd : Number(units) / 1e6;

  const submit = () => {
    withdraw.mutate(
      { asset, to: to.trim(), amount: amountNumber },
      {
        onSuccess: (r) => {
          toast.success(`Sent ${asset === "ETH" ? formatEth(r.amount) : `${formatTokenUnits(r.amount, { decimals: USDG_DECIMALS })} USDG`}`, {
            description: "View on Blockscout",
            action: { label: "Open", onClick: () => window.open(r.explorerUrl, "_blank", "noopener") },
          });
          setAmount("");
          onClose();
        },
        onError: (e) => toast.error(isHttpError(e) ? e.message : "Withdrawal failed."),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      eyebrow="Robinhood Chain"
      title="Withdraw"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={withdraw.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={withdraw.isPending} disabled={bad || !toOk || usdValue > remainingUsd}>
            Send {asset}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Tabs
          name="withdraw-asset"
          variant="pill"
          size="sm"
          value={asset}
          onChange={(a) => {
            setAsset(a);
            setAmount("");
          }}
          items={[
            { id: "ETH", label: "ETH" },
            { id: "USDG", label: "USDG" },
          ]}
        />
        <Field label="To" required error={to && !toOk ? "Enter a 0x address on Robinhood Chain." : undefined} hint="Any Robinhood Chain address. Sent on Robinhood Chain only — not Ethereum, not Arbitrum One.">
          <Input mono value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" invalid={!!to && !toOk} />
        </Field>
        <Field
          label="Amount"
          required
          meta={
            <button type="button" className="text-accent hover:underline" onClick={() => setAmount(asset === "ETH" ? (Number(ethWei) / 1e18).toString() : (Number(usdgUnits) / 1e6).toString())}>
              Max {asset === "ETH" ? formatEth(ethWei, { unit: false }) : formatTokenUnits(usdgUnits, { decimals: USDG_DECIMALS })}
            </button>
          }
          error={tooMuch ? "More than the balance." : units === -1n ? "Not a number." : undefined}
        >
          <Input mono type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" suffix={asset} invalid={tooMuch} />
        </Field>
        <div className="rounded-card border border-line bg-mono-bg px-4 py-3 text-13 text-ink-2">
          <div className="flex justify-between gap-3">
            <span>Daily limit</span>
            <span className="num text-ink">{formatUsd(BigInt(me.withdrawRemainingMicros), 0)} left of ${WITHDRAW_DAILY_CAP_USD.toLocaleString("en-US")}</span>
          </div>
          <p className="small mt-1 text-ink-3">
            A per-account cap on what can leave the custodial wallet in 24 hours. It limits the damage if a session is ever stolen; it resets on a rolling window.
            {usdValue > remainingUsd && <span className="text-warn"> This withdrawal is over today's remaining limit.</span>}
          </p>
        </div>
        <p className="small text-ink-3">Gas is paid by the platform. Transactions are irreversible once sent — check the address.</p>
      </div>
    </Sheet>
  );
};
