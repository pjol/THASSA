import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";

// Warp (admin impersonation) target store (spec §7c). This is a tiny,
// react-free module so lib/api.ts can consult it per-request WITHOUT creating an
// import cycle (api → warpStore only; the react hooks/controls live in warp.tsx).
//
// While a target is set, the Api attaches `X-Thassa-Warp: <id>` to every backend
// request and the whole app loads as that user. The target is persisted to
// expo-secure-store so a warp survives an app restart (the very first /v1/me
// then already resolves to the target because the header is attached).

const WARP_KEY = "thassa-warp";

// The persisted summary — enough to render the banner before /v1/me returns.
export interface WarpTarget {
  id: string;
  username: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

let current: WarpTarget | null = null;
let hydrated = false;
let hydration: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

// Load the persisted target once, eagerly at import time so it's ready before
// the first API request fires.
export function ensureWarpHydrated(): Promise<void> {
  if (!hydration) {
    hydration = SecureStore.getItemAsync(WARP_KEY)
      .then((raw) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as WarpTarget;
            if (parsed && typeof parsed.id === "string") current = parsed;
          } catch {
            // corrupt value — ignore
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        hydrated = true;
        notify();
      });
  }
  return hydration;
}
ensureWarpHydrated();

// Synchronous getter for the header id (may be null before hydration completes).
export function getWarpTargetId(): string | null {
  return current?.id ?? null;
}

// Async getter used by the Api per-request: guarantees the persisted target has
// been read from secure-store before returning, so a restart-into-warp attaches
// the header on the very first request.
export async function resolveWarpTargetId(): Promise<string | null> {
  if (!hydrated) await ensureWarpHydrated();
  return current?.id ?? null;
}

// Persist (or clear) the warp target and notify subscribers.
export async function persistWarpTarget(target: WarpTarget | null): Promise<void> {
  current = target;
  notify();
  try {
    if (target) await SecureStore.setItemAsync(WARP_KEY, JSON.stringify(target));
    else await SecureStore.deleteItemAsync(WARP_KEY);
  } catch {
    // best-effort persistence; in-memory state is already updated
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot(): WarpTarget | null {
  return current;
}

// Reactive hook: components re-render when the warp target changes.
export function useWarpTarget(): WarpTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
