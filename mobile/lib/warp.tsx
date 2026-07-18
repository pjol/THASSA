import { useCallback } from "react";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { useToasts } from "../components/Toasts";
import { success, warn } from "./haptics";
import { persistWarpTarget, useWarpTarget, type WarpTarget } from "./warpStore";
import type { AdminUser } from "./types";

// Warp controls (spec §7c). Kept separate from warpStore.ts (the react-free
// per-request header source) so this file can depend on session/react-query
// without creating an import cycle through lib/api.ts.
//
// Entering/exiting warp:
//   1. persist (or clear) the target in secure-store — this immediately changes
//      the X-Thassa-Warp header attached to every request;
//   2. clear the react-query cache so no other-identity data lingers;
//   3. refetch /v1/me so the whole app swaps identity. Because every subsequent
//      request already carries the header, all screens render as the target.

export interface WarpControls {
  // The persisted target, or null when not warped.
  target: WarpTarget | null;
  isWarped: boolean;
  // Warp into a user (from the admin search).
  enter: (user: AdminUser) => Promise<void>;
  // Return to the real admin identity.
  exit: () => Promise<void>;
}

export function useWarp(): WarpControls {
  const target = useWarpTarget();
  const qc = useQueryClient();
  const { refresh } = useSession();
  const router = useRouter();
  const toasts = useToasts();

  const enter = useCallback(
    async (user: AdminUser) => {
      await persistWarpTarget({
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_url: user.avatar_url,
      });
      qc.clear();
      await refresh();
      success();
      toasts.show({
        title: `Warping into @${user.username ?? "user"}`,
        body: "You're now viewing the app as this user.",
        icon: "swap-horizontal",
      });
      router.replace("/(tabs)");
    },
    [qc, refresh, router, toasts]
  );

  const exit = useCallback(async () => {
    const name = target?.username;
    await persistWarpTarget(null);
    qc.clear();
    await refresh();
    warn();
    toasts.show({
      title: "Exited warp",
      body: name ? `No longer viewing as @${name}.` : "Back to your account.",
      icon: "arrow-undo",
    });
    router.replace("/(tabs)");
  }, [qc, refresh, router, toasts, target]);

  return { target, isWarped: !!target, enter, exit };
}
