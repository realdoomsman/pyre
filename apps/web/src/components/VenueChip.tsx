import { venueOf } from "@pyre/shared";
import type { VenueRef } from "../lib/venue.js";
import { Chip, cx, type ChipTone } from "../ui/index.js";

/** "Robinhood Chain · pons v2" / "Solana · pump.fun" — where the coin lives. Lowercase on purpose (voice). */
export const VenueChip = ({ app, tone, className }: { app: VenueRef; tone?: ChipTone; className?: string }) => {
  const v = venueOf(app);
  return (
    <Chip size="sm" tone={tone} className={cx("num", className)}>
      {v.chainLabel} · {v.launchpadLabel}
    </Chip>
  );
};
