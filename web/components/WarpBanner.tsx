"use client";

// Persistent, unmistakable app-wide warp banner (spec §7c.3). Rendered whenever
// an admin is warped into a user. Amber warning treatment, fixed to the top;
// AppShell offsets its chrome/content by the banner height so nothing overlaps.

import { useSession } from "@/providers/SessionProvider";
import { useWarp, useWarpControls } from "@/providers/WarpProvider";

export const WARP_BANNER_H = 44; // px — keep in sync with AppShell offsets (h-11)

export function WarpBanner() {
  const { target, active } = useWarp();
  const { me } = useSession();
  const { exit } = useWarpControls();

  if (!active || !target) return null;

  const adminEmail = me?.warp?.admin_email;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[60] flex h-11 items-center justify-center gap-3 bg-settling px-4 text-black shadow-soft"
    >
      <span
        aria-hidden
        className="hidden h-2 w-2 shrink-0 animate-pulse rounded-full bg-black/70 sm:block"
      />
      <p className="min-w-0 truncate text-sm font-semibold">
        Viewing as <span className="font-extrabold">@{target.username}</span>
        {adminEmail ? (
          <span className="font-normal opacity-80"> · admin {adminEmail}</span>
        ) : (
          <span className="font-normal opacity-80"> · read-only</span>
        )}
      </p>
      <button
        onClick={() => exit()}
        className="shrink-0 rounded-full bg-black/85 px-3 py-1 text-xs font-bold text-white transition hover:bg-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
      >
        Exit warp
      </button>
    </div>
  );
}
