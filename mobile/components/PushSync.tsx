import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  notificationHref,
  registerForPush,
  setBeforeLogout,
  unregisterForPush,
} from "../lib/push";
import { useSession } from "../lib/session";

// Wires Expo push notifications into the app lifecycle (spec §7d.4). Rendered
// once inside the provider tree (has api + session + router). Registers on login,
// deletes the token on logout (via the pre-logout hook so the auth token is
// still valid), and deep-links notification taps to the relevant screen. Fully
// defensive — push failures never surface to the user.
export function PushSync() {
  const api = useApi();
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { me } = useSession();
  const registeredFor = useRef<string | null>(null);

  // Register once we have an authenticated user; re-register if the user changes.
  useEffect(() => {
    if (!isSignedIn || !me?.id) return;
    if (registeredFor.current === me.id) return;
    registeredFor.current = me.id;
    registerForPush(api);
  }, [api, isSignedIn, me?.id]);

  // Reset the guard on sign-out so the next login re-registers.
  useEffect(() => {
    if (!isSignedIn) registeredFor.current = null;
  }, [isSignedIn]);

  // Provide the logout hook that deletes the token while auth is still valid.
  useEffect(() => {
    setBeforeLogout(() => unregisterForPush(api));
    return () => setBeforeLogout(null);
  }, [api]);

  // Deep-link taps. Handle both a tap that launched the app from cold and taps
  // while running.
  useEffect(() => {
    let mounted = true;
    const go = (data: Record<string, unknown> | null | undefined) => {
      const href = notificationHref(data);
      if (mounted && href) router.push(href as never);
    };

    Notifications.getLastNotificationResponseAsync()
      .then((res) => {
        if (res) go(res.notification.request.content.data as Record<string, unknown>);
      })
      .catch(() => {});

    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      go(res.notification.request.content.data as Record<string, unknown>);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, [router]);

  return null;
}
