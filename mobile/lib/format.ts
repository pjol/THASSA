import { formatDistanceToNowStrict } from "date-fns";

// $ formatting. Amounts across the app are dollars (numbers); onchain units
// only exist inside lib/signing.ts.
export function dollars(n: number | null | undefined, opts?: { sign?: boolean }): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "$—";
  const sign = opts?.sign && n > 0 ? "+" : n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const s = abs >= 1000 ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 }) : abs.toFixed(2);
  return `${sign}$${s}`;
}

export function cents(p: number | null | undefined): string {
  if (p === null || p === undefined) return "—";
  return `${p}¢`;
}

// Compact counts, IG-style: 1.2K, 3.4M.
export function compact(n: number | null | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Short relative time: "3m", "2h", "5d".
export function timeAgo(iso: string): string {
  try {
    const s = formatDistanceToNowStrict(new Date(iso));
    const [num, unit] = s.split(" ");
    return `${num}${unit?.[0] ?? ""}`;
  } catch {
    return "";
  }
}

export function shortAddress(addr: string | null | undefined): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// The profile-only display name. Returns the chosen display name, or the
// username as a fallback, and never a generic "user" placeholder. Use this
// ONLY on the profile header — everywhere else, show @username directly.
export function displayName(u: { display_name?: string | null; username?: string | null }): string {
  return u.display_name?.trim() || u.username || "";
}
