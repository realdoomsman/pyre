/** Wallet glyph for the refund link buttons. Kept out of `components/icons.tsx`, which ships in the entry chunk, because only /refund draws it. */
export const IconWallet = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="1.75" y="3.5" width="12.5" height="9" rx="2" />
    <path d="M10 8h4.25" />
    <circle cx="10.5" cy="8" r="0.75" />
  </svg>
);
