import type { Response } from "express";

export const APP_CSP =
  "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; connect-src 'self' https://accounts.google.com/gsi/; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; frame-src https://accounts.google.com/gsi/; form-action 'none'; base-uri 'none'";

export function applySecurityHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", APP_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Same-origin only: nothing leaks to third parties, but same-origin `/_pyre/*` requests carry the
  // page URL, which is how a path-routed app proves its page to `enforceSameOrigin` (lib/origin.ts).
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
}
