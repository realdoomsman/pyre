import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useApp } from "../../api/queries.js";
import { formatCount, formatNative, formatUsdCompact } from "../../lib/format.js";
import { Avatar } from "../../ui/index.js";
import { ShareFrame } from "./ShareFrame.js";

/** `/c/:slug/card` — one coin's share composition: what its fees funded, who holds it. */
export const ShareCoin = () => {
  const { slug } = useParams<{ slug: string }>();
  const q = useApp(slug);
  const app = q.data;
  useEffect(() => {
    document.title = app ? `$${app.ticker} — Pyre` : "Coin card — Pyre";
  }, [app]);

  if (q.isError) {
    return <ShareFrame headline={<>this coin is <em>not</em> here.</>} stats={[{ label: "slug", value: slug ?? "—" }]} />;
  }

  return (
    <ShareFrame
      eyebrow={app ? `$${app.ticker} · pyre.fun` : "pyre.fun · Robinhood Chain"}
      media={app ? <Avatar src={app.imageUrl} name={app.ticker} size={168} shape="square" /> : undefined}
      headline={
        app ? (
          <>
            {app.name.toLowerCase()}
            <br />
            <span className="text-ink-2">fees paid</span> {formatUsdCompact(app.budgetMicros)}
            <br />
            to the <em>agent</em> building it.
          </>
        ) : (
          <>
            coins that build apps.
            <br />
            every fee <em>burns</em> PYRE.
          </>
        )
      }
      stats={[
        { label: "market cap", value: app ? formatUsdCompact(Math.round(app.mcapUsd * 1e6)) : "—" },
        { label: "fees claimed", value: app ? formatNative(app.feesWei, app.native) : "—" },
        { label: "holders", value: app ? formatCount(app.holders) : "—" },
      ]}
    />
  );
};
