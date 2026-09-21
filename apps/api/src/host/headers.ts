import type { Response } from "express";

export const APP_CSP =
  "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; connect-src 'self' https://accounts.google.com/gsi/; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; frame-src https://accounts.google.com/gsi/; form-action 'none'; base-uri 'none'";

export function applySecurityHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", APP_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
}
