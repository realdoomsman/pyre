import { useEffect } from "react";
import { useStats } from "../../api/queries.js";
import { formatCount, formatEth, formatUsdCompact } from "../../lib/format.js";
import { ShareFrame } from "./ShareFrame.js";

/** `/card` — the network share composition. Screenshotted for og:image; no chrome. */
export const ShareBoard = () => {
  const stats = useStats();
  useEffect(() => {
    document.title = "Share card — Pyre";
  }, []);
  const s = stats.data;
  return (
    <ShareFrame
      headline={
        <>
          coins that build apps.
          <br />
          revenue <em>burns</em> them.
        </>
      }
      stats={[
        { label: "apps live", value: s ? formatCount(s.appsLive) : "—" },
        { label: "revenue", value: s ? formatUsdCompact(s.revenueTotalMicros) : "—" },
        { label: "burned", value: s ? formatEth(s.burnedEthWei) : "—" },
      ]}
    />
  );
};
