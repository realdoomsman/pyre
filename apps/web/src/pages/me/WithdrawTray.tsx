import { useState } from "react";
import type { MeDto } from "@pyre/shared";
import { WITHDRAW_DAILY_CAP_USD, decimalToUnits, USDG_DECIMALS } from "@pyre/shared";
import { isHttpError } from "../../api/client.js";
import { ETH, SOL, formatNative, formatTokenUnits, formatUsd, nativeToNumber } from "../../lib/format.js";
import { EVM_ADDRESS, SOLANA_ADDRESS } from "../../lib/venue.js";
import { Button, Field, Input, Sheet, Tabs, toast } from "../../ui/index.js";
import { useWithdraw, type WithdrawInput } from "./hooks.js";

type Asset = WithdrawInput["asset"];

interface Props {
  open: boolean;
  onClose: () => void;
  me: MeDto;
}

/** Withdraw from the custodial wallets: ETH / USDG leave on Robinhood Chain, SOL leaves on Solana. */
export const WithdrawTray = ({ open, onClose, me }: Props) => {
  const [asset, setAsset] = useState<Asset>("ETH");
  const [to, setTo] = useState(me.authWallet ?? "");
  const [amount, setAmount] = useState("");
  const withdraw = useWithdraw();

  const solana = asset === "SOL";
  const ethWei = BigInt(me.balances.ethWei);
  const usdgUnits = BigInt(me.balances.usdgUnits);
  const solLamports = BigInt(me.balances.solLamports);
  const available = asset === "ETH" ? ethWei : asset === "SOL" ? solLamports : usdgUnits;
  const decimals = asset === "ETH" ? ETH.decimals : asset === "SOL" ? SOL.decimals : USDG_DECIMALS;
  let units = 0n;
  try {
    units = amount ? decimalToUnits(amount, decimals) : 0n;
  } catch {
    units = -1n;
  }
  const amountNumber = Number(amount);
  const tooMuch = units > available;
  const bad = units <= 0n || tooMuch || !Number.isFinite(amountNumber);
  const toOk = (solana ? SOLANA_ADDRESS : EVM_ADDRESS).test(to.trim());
  const remainingUsd = Number(BigInt(me.withdrawRemainingMicros)) / 1e6;
  const usdValue = asset === "ETH" ? nativeToNumber(units, ETH) * me.balances.ethPriceUsd : asset === "SOL" ? nativeToNumber(units, SOL) * me.balances.solPriceUsd : Number(units) / 1e6;
  const chainLabel = solana ? "Solana" : "Robinhood Chain";
  const explorerName = solana ? "Solscan" : "Blockscout";

  const submit = () => {
    withdraw.mutate(
      { asset, to: to.trim(), amount: amountNumber },
      {
        onSuccess: (r) => {
          const sent = r.asset === "ETH" ? formatNative(r.amount, ETH) : r.asset === "SOL" ? formatNative(r.amount, SOL) : `${formatTokenUnits(r.amount, { decimals: USDG_DECIMALS })} USDG`;
          toast.success(`Sent ${sent}`, {
            description: `View on ${explorerName}`,
            action: { label: "Open", onClick: () => window.open(r.explorerUrl, "_blank", "noopener") },
          });
          setAmount("");
          onClose();
        },
        onError: (e) => toast.error(isHttpError(e) ? e.message : "Withdrawal failed."),
      },
    );
  };

  const max = asset === "ETH" ? nativeToNumber(ethWei, ETH) : asset === "SOL" ? nativeToNumber(solLamports, SOL) : Number(usdgUnits) / 1e6;
  const maxLabel = asset === "ETH" ? formatNative(ethWei, ETH, { unit: false }) : asset === "SOL" ? formatNative(solLamports, SOL, { unit: false }) : formatTokenUnits(usdgUnits, { decimals: USDG_DECIMALS });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      eyebrow={chainLabel}
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
            // A proven EVM wallet is a sensible default on Robinhood Chain; never on Solana.
            setTo(a === "SOL" ? "" : (me.authWallet ?? ""));
          }}
          items={[
            { id: "ETH", label: "ETH" },
            { id: "USDG", label: "USDG" },
            ...(me.solWallet ? [{ id: "SOL" as const, label: "SOL" }] : []),
          ]}
        />
        <Field
          label="To"
          required
          error={to && !toOk ? (solana ? "Enter a Solana address (base58)." : "Enter a 0x address on Robinhood Chain.") : undefined}
          hint={solana ? "Any Solana address. Sent on Solana only — not wrapped, not bridged." : "Any Robinhood Chain address. Sent on Robinhood Chain only — not Ethereum, not Arbitrum One."}
        >
          <Input mono value={to} onChange={(e) => setTo(e.target.value)} placeholder={solana ? "base58 address" : "0x…"} spellCheck={false} autoComplete="off" invalid={!!to && !toOk} />
        </Field>
        <Field
          label="Amount"
          required
          meta={
            <button type="button" className="text-accent hover:underline" onClick={() => setAmount(max.toString())}>
              Max {maxLabel}
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
            A per-account cap on what can leave the custodial wallets in 24 hours, across both chains. It limits the damage if a session is ever stolen; it resets on a rolling window.
            {usdValue > remainingUsd && <span className="text-warn"> This withdrawal is over today's remaining limit.</span>}
          </p>
        </div>
        <p className="small text-ink-3">{solana ? "Network fees are paid by the platform." : "Gas is paid by the platform."} Transactions are irreversible once sent — check the address.</p>
      </div>
    </Sheet>
  );
};
