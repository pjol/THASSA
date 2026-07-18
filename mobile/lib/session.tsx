import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, AppStateStatus } from "react-native";
import { useAuth, useWallet } from "./auth";
import { useApi } from "./api";
import { setCachePinnedIdentity } from "./cache";
import { startSocket, stopSocket, useUserChannel, WsEvent } from "./ws";
import type { Me } from "./types";

type Status = "loading" | "ready" | "error";

interface SessionState {
  me: Me | null;
  status: Status;
  // Unread in-app notification count (bell badge) and unread DM count.
  unreadNotifications: number;
  unreadMessages: number;
  refresh: () => Promise<void>;
  refreshBadges: () => void;
  // Optimistic local update after PATCH /v1/me | /v1/me/settings.
  setMe: (updater: (m: Me) => Me) => void;
  // Screens can hook the user channel feed through session-level subscribers.
  onUserEvent: (fn: (e: WsEvent) => void) => () => void;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { isReady, isSignedIn, userId, getAccessToken } = useAuth();
  const api = useApi();
  const [me, setMeState] = useState<Me | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [subscribers] = useState(() => new Set<(e: WsEvent) => void>());

  // Keep one app-wide socket open while signed in.
  useEffect(() => {
    if (isSignedIn) startSocket(getAccessToken);
    else stopSocket();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  const refreshBadges = useCallback(() => {
    api
      .get<{ unread_notifications: number; unread_messages: number }>("/v1/me/badges")
      .then((b) => {
        setUnreadNotifications(b.unread_notifications ?? 0);
        setUnreadMessages(b.unread_messages ?? 0);
      })
      .catch(() => {});
  }, [api]);

  // Live badge + fan-out of user-channel events (toasts, screens).
  useUserChannel(me?.id ?? null, (e) => {
    if (e.type === "notification") {
      if (e.payload.kind === "dm.message") setUnreadMessages((n) => n + 1);
      else setUnreadNotifications((n) => n + 1);
    }
    subscribers.forEach((fn) => fn(e));
  });

  const onUserEvent = useCallback(
    (fn: (e: WsEvent) => void) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    [subscribers]
  );

  // Tracks whether we have a loaded profile without retriggering load() on
  // every me change (a state dep would re-run the auth effect below).
  const hasMeRef = useRef(false);
  useEffect(() => {
    hasMeRef.current = me != null;
  }, [me]);

  // Embedded wallet address (null until Privy creates one), read through a
  // ref so load() stays dependency-stable.
  const { address: embeddedAddress } = useWallet();
  const embeddedAddressRef = useRef<string | null>(embeddedAddress);
  embeddedAddressRef.current = embeddedAddress;

  const load = useCallback(async () => {
    // Stay "ready" only for background refreshes when a profile is already
    // loaded. With no profile yet (fresh sign-in), status must be "loading" —
    // otherwise the entry gate reads ready+no-me as a connection error and
    // flashes it for the whole duration of the first /v1/me fetch.
    setStatus((s) => (s === "ready" && hasMeRef.current ? s : "loading"));
    try {
      // /v1/me is the critical call — failure here means we can't reach the
      // backend (or auth is broken), so surface a connection error. The backend
      // wraps the profile as { me: {...} } (with is_admin/warp merged in).
      const res = await api.get<{ me: Me }>("/v1/me");
      setMeState(res.me);
      // Privy access tokens don't always carry a wallet claim, so the backend
      // may not know the embedded wallet yet — register it so orders/balance
      // work (idempotent; the backend verifies ownership when configured).
      if (!res.me.wallet_address && embeddedAddressRef.current) {
        api
          .post<{ me: Me }>("/v1/me/wallet", { address: embeddedAddressRef.current })
          .then((r) => setMeState(r.me))
          .catch(() => {});
      }
      // Prioritize this user's own profile/posts for cache retention (pinned
      // tier) so /v1/users/{me}/... responses survive eviction longest.
      setCachePinnedIdentity(res.me.username ?? null);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [api]);

  useEffect(() => {
    if (!isReady) return;
    if (!isSignedIn) {
      setStatus("ready");
      setMeState(null);
      setCachePinnedIdentity(null);
      return;
    }
    load();
  }, [isReady, isSignedIn, load]);

  // On every app foregrounding, re-sync the session + badges.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s: AppStateStatus) => {
      if (s === "active" && isSignedIn) {
        load();
        refreshBadges();
      }
    });
    return () => sub.remove();
  }, [isSignedIn, load, refreshBadges]);

  useEffect(() => {
    if (isSignedIn && me) refreshBadges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, me?.id]);

  const setMe = useCallback((updater: (m: Me) => Me) => {
    setMeState((m) => (m ? updater(m) : m));
  }, []);

  return (
    <Ctx.Provider
      value={{
        me,
        status,
        unreadNotifications,
        unreadMessages,
        refresh: load,
        refreshBadges,
        setMe,
        onUserEvent,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}

// True when the signed-in user still needs the onboarding step (no username).
export function needsOnboarding(me: Me | null): boolean {
  return !!me && !(me.onboarded ?? !!me.username);
}
