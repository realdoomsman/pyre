import { useEffect } from "react";
import { useStats } from "../../api/queries.js";
import { SOL, formatCount, formatNative } from "../../lib/format.js";
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
          every coin <em>burns</em> itself.
        </>
      }
      stats={[
        { label: "apps live", value: s ? formatCount(s.appsLive) : "—" },
        { label: "fees claimed", value: s ? formatNative(s.feesTotalLamports, SOL) : "—" },
        { label: "coins launched", value: s ? formatCount(s.appsTotal) : "—" },
      ]}
    />
  );
};
