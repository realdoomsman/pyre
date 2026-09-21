import type { SVGProps } from "react";

/*
 * 16-unit stroke icons, 1.5px, round caps. `size` scales the box; colour is
 * `currentColor`. No filled glyphs, no flames.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const Svg = ({ size = 16, children, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...rest}
  >
    {children}
  </svg>
);

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V7.5Z" />
    <path d="M6.5 13.5v-4h3v4" />
  </Svg>
);
export const IconApps = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
  </Svg>
);
/** Burn: a tile whose lower edge is gone — supply leaving, not a flame. */
export const IconBurn = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3.5A1 1 0 0 1 4 2.5h8a1 1 0 0 1 1 1V9" />
    <path d="M3 3.5V9" />
    <path d="M3 9c1.2 1.4 2.3 1.4 3.5 0s2.3-1.4 3.5 0 2.3 1.4 3 0" />
    <path d="M4.5 12.5h7" strokeOpacity="0.5" />
  </Svg>
);
/** The mark, mono: rounded tile with the temper line. */
export const IconPyre = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
    <path d="M2.5 9.2Q8 7.4 13.5 9.2" strokeOpacity="0.6" />
    <path d="M4 13.5h8" strokeWidth="2" />
  </Svg>
);
export const IconLaunch = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13V3" />
    <path d="m4 7 4-4 4 4" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.3 10.3 3.2 3.2" />
  </Svg>
);
export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="5.5" r="2.75" />
    <path d="M2.75 13.5c.6-2.6 2.6-4 5.25-4s4.65 1.4 5.25 4" />
  </Svg>
);
export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11Z" />
    <path d="M6.5 14a1.5 1.5 0 0 0 3 0" />
  </Svg>
);
export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3.5H4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V9" />
    <path d="M9.5 3h3.5v3.5" />
    <path d="M13 3 7.5 8.5" />
  </Svg>
);
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8h10" />
    <path d="m9 4 4 4-4 4" />
  </Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 6 4 4 4-4" />
  </Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 8.5 3.2 3L13 4.5" />
  </Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5A1 1 0 0 0 9.5 2.5h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </Svg>
);
export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6" />
    <path d="M13 2.5v3h-3" />
  </Svg>
);
export const IconGitHub = (p: IconProps) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" fill="currentColor" aria-hidden className={p.className}>
    <path d="M8 .4a7.8 7.8 0 0 0-2.47 15.2c.39.07.53-.17.53-.38v-1.33c-2.17.47-2.63-1.05-2.63-1.05-.35-.9-.87-1.14-.87-1.14-.71-.49.05-.48.05-.48.79.06 1.2.81 1.2.81.7 1.2 1.83.85 2.28.65.07-.51.27-.85.5-1.05-1.73-.2-3.55-.87-3.55-3.86 0-.85.3-1.55.8-2.1-.08-.2-.35-.99.08-2.06 0 0 .65-.21 2.14.8a7.4 7.4 0 0 1 3.9 0c1.49-1.01 2.14-.8 2.14-.8.43 1.07.16 1.86.08 2.06.5.55.8 1.25.8 2.1 0 3-1.83 3.66-3.57 3.85.28.24.53.72.53 1.45v2.15c0 .21.14.46.54.38A7.8 7.8 0 0 0 8 .4Z" />
  </svg>
);
export const IconX = (p: IconProps) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" fill="currentColor" aria-hidden className={p.className}>
    <path d="M12.2 1.5h2.2L9.6 7l5.6 7.5h-4.4L7.4 9.9 3.5 14.5H1.3l5.1-5.9L1 1.5h4.5l3.1 4.2 3.6-4.2Zm-.8 11.7h1.2L4.7 2.7H3.4l8 10.5Z" />
  </svg>
);
export const IconSpark = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.5v11M2.5 8h11M4.5 4.5l7 7M11.5 4.5l-7 7" strokeOpacity="0.7" />
  </Svg>
);
