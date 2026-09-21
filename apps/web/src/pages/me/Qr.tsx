import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Skeleton } from "../../ui/index.js";

/** A scannable QR of `value`. 1-bit by nature, so it scales with `pixelated` and stays crisp. */
export const Qr = ({ value, size = 160, className }: { value: string; size?: number; className?: string }) => {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(value, { margin: 1, width: size * 2, color: { dark: "#000000", light: "#ffffff" } }).then(
      (url) => alive && setSrc(url),
      () => alive && setSrc(null),
    );
    return () => {
      alive = false;
    };
  }, [value, size]);
  if (!src) return <Skeleton className={className} rounded="card" />;
  return <img src={src} width={size} height={size} alt={`QR code for ${value}`} className={className} style={{ imageRendering: "pixelated" }} />;
};
