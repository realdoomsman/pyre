import { useEffect, useRef, useState } from "react";
import { cx } from "./cx.js";
import { clamp01 } from "./heat.js";

export interface SupplyKilnProps {
  /** Share of total supply burned, 0–1. Layers hollow from the top. */
  burnedFraction: number;
  /** Number of blocks in the stack. */
  layers?: number;
  /** Rendered width in px; height follows. */
  width?: number;
  /** Mono label under the stack. Default shows the burned percentage. */
  label?: string | null;
  /** Called with the layer index under the pointer (0 = bottom), or null. */
  onLayerHover?: (layer: number | null) => void;
  className?: string;
}

/*
 * Isometric geometry. A block is a rhombus top and two side faces; the stack
 * grows upward by `h` per layer. All strokes are ink line-art in the
 * Robinhood Chain / Linear idiom; fills are quiet surface tints.
 */
const ISO = { w: 120, h: 18, pad: 8 } as const;

const faces = (cx0: number, top: number, w: number, h: number) => {
  const half = w / 2;
  const q = w / 4;
  return {
    top: `${cx0},${top} ${cx0 + half},${top + q} ${cx0},${top + half} ${cx0 - half},${top + q}`,
    left: `${cx0 - half},${top + q} ${cx0},${top + half} ${cx0},${top + half + h} ${cx0 - half},${top + q + h}`,
    right: `${cx0 + half},${top + q} ${cx0},${top + half} ${cx0},${top + half + h} ${cx0 + half},${top + q + h}`,
  };
};

/**
 * Supply Kiln. Every coin's supply is a stack of blocks. Each burn hollows a
 * layer to wireframe with a 400ms easeOutQuart collapse; the most recently
 * burned layer glows in the accent as it cools from white-hot.
 */
export const SupplyKiln = ({ burnedFraction, layers = 10, width = 160, label, onLayerHover, className }: SupplyKilnProps) => {
  const burned = clamp01(burnedFraction);
  const hollow = Math.min(layers, Math.floor(burned * layers + 1e-9));
  // The layer currently being eaten (partial), drawn with a proportional fill.
  const partial = burned * layers - hollow;

  // Track which layer most recently went hollow so it can glow; clears after cooling.
  const prevHollow = useRef(hollow);
  const [recent, setRecent] = useState<number | null>(null);
  useEffect(() => {
    if (hollow === prevHollow.current) return;
    prevHollow.current = hollow;
    if (hollow === 0) return;
    setRecent(layers - hollow);
    const t = setTimeout(() => setRecent(null), 1400);
    return () => clearTimeout(t);
  }, [hollow, layers]);

  const scale = width / (ISO.w + ISO.pad * 2);
  const w = ISO.w;
  const h = ISO.h;
  const cx0 = ISO.pad + w / 2;
  const totalH = h * layers + w / 2 + ISO.pad * 2;
  const viewW = ISO.w + ISO.pad * 2;

  return (
    <figure className={cx("inline-flex flex-col items-center gap-2", className)} style={{ width }}>
      <svg
        width={viewW * scale}
        height={totalH * scale}
        viewBox={`0 0 ${viewW} ${totalH}`}
        role="img"
        aria-label={`${Math.round(burned * 100)}% of supply burned`}
        className="text-ink"
      >
        {Array.from({ length: layers }, (_, k) => {
          // k = 0 is the bottom layer; draw bottom first so upper faces overlap.
          const top = ISO.pad + (layers - 1 - k) * h;
          const f = faces(cx0, top, w, h);
          const isHollow = k >= layers - hollow;
          const isPartial = !isHollow && k === layers - hollow - 1 && partial > 0.02;
          const isRecent = recent === k;
          const stroke = isHollow ? "var(--color-ink-3)" : "currentColor";
          return (
            <g
              key={k}
              data-layer={k}
              data-hollow={isHollow || undefined}
              onMouseEnter={onLayerHover ? () => onLayerHover(k) : undefined}
              onMouseLeave={onLayerHover ? () => onLayerHover(null) : undefined}
              className={cx(isRecent && "animate-cool")}
              style={{ color: isRecent ? undefined : stroke }}
            >
              <title>{isHollow ? `Layer ${k + 1}: burned` : isPartial ? `Layer ${k + 1}: ${Math.round(partial * 100)}% burned` : `Layer ${k + 1}`}</title>
              <polygon
                points={f.left}
                fill="var(--color-surface)"
                stroke={isRecent ? "currentColor" : stroke}
                strokeWidth="1"
                strokeLinejoin="round"
                fillOpacity={isHollow ? 0 : 1}
                className="transition-[fill-opacity] duration-(--duration-reveal) ease-(--ease-reveal)"
              />
              <polygon
                points={f.right}
                fill="var(--color-raised)"
                stroke={isRecent ? "currentColor" : stroke}
                strokeWidth="1"
                strokeLinejoin="round"
                fillOpacity={isHollow ? 0 : 1}
                className="transition-[fill-opacity] duration-(--duration-reveal) ease-(--ease-reveal)"
              />
              <polygon
                points={f.top}
                fill="var(--color-line-2)"
                stroke={isRecent ? "currentColor" : stroke}
                strokeWidth="1"
                strokeLinejoin="round"
                fillOpacity={isHollow ? 0 : isPartial ? 1 - partial : 1}
                strokeDasharray={isHollow ? "3 3" : undefined}
                className="transition-[fill-opacity] duration-(--duration-reveal) ease-(--ease-reveal)"
              />
            </g>
          );
        })}
      </svg>
      {label !== null && (
        <figcaption className="num text-13 text-ink-2">
          {label ?? (
            <>
              <span className="text-burn">{(burned * 100).toFixed(2)}%</span> burned
            </>
          )}
        </figcaption>
      )}
    </figure>
  );
};
