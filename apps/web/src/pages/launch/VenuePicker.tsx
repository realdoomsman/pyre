import type { Launchpad, VenuesDto } from "@pyre/shared";
import { VENUES } from "@pyre/shared";
import { formatNative } from "../../lib/format.js";
import { Chip, Skeleton, cx } from "../../ui/index.js";

type VenueRow = VenuesDto["venues"][number];

/** What the 25% burn leg does on each chain — the one economic difference a launcher must see. */
const BURN_COPY: Record<Launchpad, string> = {
  pons_v2: "25% of fees buys and burns PYRE",
  pump_fun: "25% of fees buys and burns the coin",
};

interface Props {
  value: Launchpad;
  onChange: (launchpad: Launchpad) => void;
  /** `undefined` while `/v1/venues` loads. */
  venues: ReadonlyArray<VenueRow> | undefined;
  /** A fork launches on its parent's venue; the picker shows why it is fixed. */
  locked?: { launchpad: Launchpad; reason: string } | null;
  disabled?: boolean;
}

/**
 * Step 1's first question: where does the coin launch? One card per venue the API offers,
 * with the chain, the launchpad, the stake it asks for and where the burn leg goes. A venue
 * the API reports as disabled stays visible but cannot be picked.
 */
export const VenuePicker = ({ value, onChange, venues, locked, disabled }: Props) => {
  if (!venues) {
    return (
      <div className="grid gap-3 sm:grid-cols-2" aria-busy>
        <Skeleton className="h-28" rounded="card" />
        <Skeleton className="h-28" rounded="card" />
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label="Launch venue" className="grid gap-3 sm:grid-cols-2">
      {venues.map((v) => {
        const meta = VENUES[v.launchpad];
        const selected = v.launchpad === value;
        const off = !v.enabled || disabled || (locked ? locked.launchpad !== v.launchpad : false);
        return (
          <button
            key={v.launchpad}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={off || undefined}
            disabled={off}
            onClick={() => !off && onChange(v.launchpad)}
            className={cx(
              "flex flex-col gap-2 rounded-card border p-4 text-left outline-none transition-[border-color,background-color] duration-(--duration-ui) ease-(--ease-ui)",
              selected ? "border-accent bg-accent-wash" : "border-line bg-surface",
              off ? "cursor-not-allowed opacity-60" : "hover:border-line-2 focus-visible:border-accent",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-15 font-medium text-ink">{meta.chainLabel}</div>
                <div className="num text-13 text-ink-2">{meta.launchpadLabel}</div>
              </div>
              {!v.enabled ? (
                <Chip size="sm" tone="warn">
                  not available
                </Chip>
              ) : selected ? (
                <Chip size="sm" tone="accent" dot>
                  selected
                </Chip>
              ) : null}
            </div>
            <dl className="num grid grid-cols-2 gap-x-3 text-12">
              <div>
                <dt className="eyebrow">stake</dt>
                <dd className="text-ink">{formatNative(v.stakeWei, v.native, { digits: v.native.symbol === "SOL" ? 0 : 2 })}</dd>
              </div>
              <div>
                <dt className="eyebrow">coin</dt>
                <dd className="text-ink">1B supply · {v.tokenDecimals} dec</dd>
              </div>
            </dl>
            <p className="small text-ink-3">{BURN_COPY[v.launchpad]}. Refundable stake, spam control only.</p>
            {locked && locked.launchpad === v.launchpad && <p className="small text-ink-3">{locked.reason}</p>}
          </button>
        );
      })}
    </div>
  );
};
