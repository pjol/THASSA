"use client";

// Tiny QR component backed by the `qrcode` package (renders to a data URL,
// no canvas kept around). Used by the wallet Receive card.

import { useEffect, useState } from "react";
import QR from "qrcode";

export function QRCode({
  value,
  size = 176,
  className = "",
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QR.toDataURL(value, {
      width: size * 2, // 2x for retina
      margin: 1,
      color: { dark: "#0A0A0A", light: "#FFFFFF" },
    })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!src)
    return (
      <div
        className={`skeleton ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`QR code for ${value}`}
      width={size}
      height={size}
      className={`rounded-2xl border border-edge bg-white p-2 ${className}`}
    />
  );
}
