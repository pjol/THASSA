// Display formatting helpers.

import { PAYMENT_TOKEN_DECIMALS } from "@/lib/config";

// Token units (decimal string or bigint) → "$12.34". Payouts display floors.
export function fmtUnits(units: string | bigint | null | undefined): string {
  if (units === null || units === undefined) return "$0.00";
  let u: bigint;
  try {
    u = typeof units === "bigint" ? units : BigInt(units || "0");
  } catch {
    return "$0.00";
  }
  const neg = u < 0n;
  if (neg) u = -u;
  const unit = 10n ** BigInt(PAYMENT_TOKEN_DECIMALS);
  const dollars = u / unit;
  const cents = (u % unit) * 100n / unit;
  return `${neg ? "-" : ""}$${dollars}.${cents.toString().padStart(2, "0")}`;
}

export function fmtSignedUnits(units: string | bigint): string {
  const s = fmtUnits(units);
  return s.startsWith("-") ? s : `+${s}`;
}

export function fmtDollars(d: number): string {
  return `$${d.toFixed(2)}`;
}

export function fmtCents(c: number): string {
  return `${c}¢`;
}

// Compact volume: "$1.2k", "$3.4M".
export function fmtVolume(units: string | null | undefined): string {
  if (!units) return "$0";
  let u: bigint;
  try {
    u = BigInt(units);
  } catch {
    return "$0";
  }
  const d = Number(u / 10n ** BigInt(PAYMENT_TOKEN_DECIMALS - 2)) / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(1)}k`;
  return `$${d.toFixed(0)}`;
}

// Instagram-style relative time: "3s", "5m", "2h", "4d", "6w".
export function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 52) return `${w}w`;
  return `${Math.floor(w / 52)}y`;
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function shortAddress(addr: string | null | undefined): string {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function displayName(u: {
  display_name?: string | null;
  username?: string | null;
}): string {
  return u.display_name?.trim() || u.username || "";
}
