import { useEffect } from "react";
import { useStats } from "../../api/queries.js";
import { formatCount, formatEth } from "../../lib/format.js";
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
          every fee <em>burns</em> PYRE.
        </>
      }
      stats={[
        { label: "apps live", value: s ? formatCount(s.appsLive) : "—" },
        { label: "fees claimed", value: s ? formatEth(s.feesTotalWei) : "—" },
        { label: "PYRE burned", value: s ? formatEth(s.burnedEthWei) : "—" },
      ]}
    />
  );
};
