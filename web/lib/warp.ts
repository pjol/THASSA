// Warp (admin impersonation) store — spec §7c. An admin can "warp" into any
// user to view the app as them. The mechanism is a single request header:
// `X-Thassa-Warp: <targetUserId>` attached to EVERY backend call (see lib/api.ts),
// which makes the backend return/gate all data as that user (read-only).
//
// This module is framework-agnostic (no React) so the Api class can consult a
// module-level getter per request, exactly like it reads static config. The
// React binding lives in providers/WarpProvider.tsx and drives this store via
// an external-store subscription.

export interface WarpTarget {
  id: string;
  username: string;
  email?: string | null;
  avatar_url?: string | null;
}

const STORAGE_KEY = "thassa-warp";

let current: WarpTarget | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

// Lazily read the persisted target once, on first access (client only).
function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WarpTarget;
      if (parsed && typeof parsed.id === "string" && parsed.id) current = parsed;
    }
  } catch {
    current = null;
  }
}

// Module-level getters the Api instance consults per request.
export function getWarpTarget(): WarpTarget | null {
  hydrate();
  return current;
}

export function getWarpTargetId(): string | null {
  return getWarpTarget()?.id ?? null;
}

// Set (or clear with null) the warp target: updates the module value, mirrors
// it to localStorage, and notifies React subscribers.
export function setWarpTarget(target: WarpTarget | null): void {
  hydrate();
  current = target;
  if (typeof window !== "undefined") {
    try {
      if (target) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable (private mode) — in-memory state still works */
    }
  }
  for (const l of listeners) l();
}

// External-store subscription plumbing for useSyncExternalStore.
export function subscribeWarp(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Stable server snapshot (no warp during SSR/prerender).
export function warpServerSnapshot(): WarpTarget | null {
  return null;
}
