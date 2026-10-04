import { venueOf } from "@pyre/shared";
import { isLaunchable, type VenueRef } from "../lib/venue.js";
import { Chip, cx, type ChipTone } from "../ui/index.js";

/** "Solana · pump.fun" / "Robinhood Chain · pons v2 · legacy" — where the coin lives. Lowercase on purpose (voice). */
export const VenueChip = ({ app, tone, className }: { app: VenueRef; tone?: ChipTone; className?: string }) => {
  const v = venueOf(app);
  return (
    <Chip size="sm" tone={tone} className={cx("num", className)}>
      {v.chainLabel} · {v.launchpadLabel}
      {isLaunchable(app.launchpad) ? null : " · legacy"}
    </Chip>
  );
};
