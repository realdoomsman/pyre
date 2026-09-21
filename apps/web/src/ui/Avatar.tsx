import { useState, type CSSProperties } from "react";
import { cx } from "./cx.js";

export interface AvatarProps {
  src?: string | null;
  /** Name or ticker; the fallback shows its initials. */
  name: string;
  size?: number;
  shape?: "circle" | "square";
  className?: string;
}

/* Six quiet tints for initials. Not a rainbow, never a role colour. */
const TINTS = ["#2a2740", "#1f2f3f", "#2f2a26", "#1f3330", "#33262f", "#26303a"];
const LIGHT_TINTS = ["#e4e8fb", "#dfe9f3", "#f0e9dc", "#dfeee8", "#f3e2ea", "#e6ebef"];

const hashOf = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export const initialsOf = (name: string): string => {
  const clean = name.replace(/^\$/, "").trim();
  const words = clean.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
};

export const Avatar = ({ src, name, size = 40, shape = "circle", className }: AvatarProps) => {
  const [broken, setBroken] = useState(false);
  const radius = shape === "circle" ? "rounded-pill" : "rounded-control";
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) };
  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={cx("shrink-0 border border-line bg-raised object-cover", radius, className)}
        style={style}
      />
    );
  }
  const i = hashOf(name) % TINTS.length;
  return (
    <span
      role="img"
      aria-label={name}
      className={cx("inline-flex shrink-0 items-center justify-center border border-line bg-(--tint) font-medium text-ink-2 light:bg-(--tint-light)", radius, className)}
      style={{ ...style, "--tint": TINTS[i], "--tint-light": LIGHT_TINTS[i] } as CSSProperties}
    >
      {initialsOf(name)}
    </span>
  );
};
