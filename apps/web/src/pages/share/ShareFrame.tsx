import type { ReactNode } from "react";
import { Lockup } from "../../components/Lockup.js";

export interface ShareStat {
  label: string;
  value: ReactNode;
}

/**
 * The OG composition from `marketing/brand/pyre/og.html`: a 1200×630
 * tempered card — heat rising from the bottom edge, the lockup top-left, the
 * serif line with one italic word, three mono stats on a hairline. Fixed
 * pixel sizes on purpose: this is captured, never laid out.
 */
export const ShareFrame = ({ headline, stats, eyebrow = "pyre.fun · Robinhood Chain", media }: { headline: ReactNode; stats: ShareStat[]; eyebrow?: string; media?: ReactNode }) => (
  <main className="relative h-[630px] w-[1200px] overflow-hidden bg-canvas text-ink" style={{ fontSize: 16 }}>
    <div
      className="absolute inset-x-0 bottom-0 h-[300px]"
      style={{
        background:
          "radial-gradient(70% 60% at 50% 100%, rgba(156,210,255,.22), rgba(62,139,255,.16) 30%, rgba(122,102,245,.08) 58%, transparent 80%), linear-gradient(180deg, transparent, rgba(28,27,46,.5) 60%, rgba(59,47,122,.42))",
      }}
      aria-hidden
    />
    <div className="absolute left-[72px] top-[64px]">
      <Lockup height={74} />
    </div>
    <div className="num absolute right-[72px] top-[86px] text-[16px] uppercase tracking-[0.06em] text-ink-2">{eyebrow}</div>
    {media && <div className="absolute right-[72px] top-[190px]">{media}</div>}
    <div className="display absolute left-[68px] top-[196px] max-w-[760px] text-[88px] leading-[1.02] [&_em]:text-accent">{headline}</div>
    <div className="absolute inset-x-[72px] bottom-[60px] flex border-t border-line pt-[26px]">
      {stats.map((s, i) => (
        <div key={s.label} className={i === 0 ? "num flex-1" : "num flex-1 border-l border-line pl-[32px]"}>
          <div className="mb-[12px] text-[14px] uppercase tracking-[0.06em] text-ink-2">{s.label}</div>
          <div className="text-[36px] tracking-[-0.01em] text-ink">{s.value}</div>
        </div>
      ))}
    </div>
    <div className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: "linear-gradient(90deg, transparent, #9CD2FF 25%, #E9F1FF 50%, #9CD2FF 75%, transparent)" }} aria-hidden />
  </main>
);
