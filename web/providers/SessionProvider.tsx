"use client";

// Session provider (ASSEMBLY Providers.tsx pattern): loads /v1/me once Privy
// reports an authenticated user, exposes it app-wide, and boots the shared
// WebSocket with the token getter.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useAuth, useAuthToken } from "@/providers/AuthProvider";
import { useApi } from "@/lib/api";
import { socket } from "@/lib/ws";
import type { Me } from "@/lib/types";

interface Session {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { ready, authenticated } = useAuth();
  const api = useApi();
  const getToken = useAuthToken();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ me: Me }>("/v1/me");
      setMe(res.me);
    } catch {
      // unauthenticated / backend unavailable
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) {
      setMe(null);
      setLoading(false);
      socket.stop();
      return;
    }
    setLoading(true);
    load();
    socket.start(getToken);
    return () => socket.stop();
  }, [ready, authenticated, load, getToken]);

  return (
    <Ctx.Provider value={{ me, loading, refresh: load }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession(): Session {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
