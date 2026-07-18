"use client";

// React binding for the warp store (spec §7c). `useWarp` exposes the current
// impersonation target reactively; `useWarpControls` performs the identity
// swap: set/clear the target, wipe every react-query cache so no stale
// (previous identity) data lingers, refetch /v1/me so the whole app re-renders
// as the new user, toast, and navigate home.

import { useCallback, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/providers/SessionProvider";
import { useToast } from "@/providers/ToastProvider";
import {
  getWarpTarget,
  setWarpTarget,
  subscribeWarp,
  warpServerSnapshot,
  type WarpTarget,
} from "@/lib/warp";

export type { WarpTarget };

export function useWarp(): { target: WarpTarget | null; active: boolean } {
  const target = useSyncExternalStore(
    subscribeWarp,
    getWarpTarget,
    warpServerSnapshot,
  );
  return { target, active: !!target };
}

export function useWarpControls() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { refresh } = useSession();
  const toast = useToast();

  const enter = useCallback(
    async (target: WarpTarget) => {
      setWarpTarget(target);
      // Drop all cached data captured under the previous identity, then reload
      // /v1/me so the header now in effect returns the target user everywhere.
      queryClient.clear();
      await refresh();
      toast.success(`Warping into @${target.username}`);
      router.push("/");
    },
    [queryClient, refresh, toast, router],
  );

  const exit = useCallback(async () => {
    setWarpTarget(null);
    queryClient.clear();
    await refresh();
    toast.success("Exited warp");
    router.push("/");
  }, [queryClient, refresh, toast, router]);

  return { enter, exit };
}
