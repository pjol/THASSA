import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { radius, useTheme } from "../lib/theme";
import { useSession } from "../lib/session";
import { thud } from "../lib/haptics";
import type { AppNotification } from "../lib/types";

// In-app toasts, fed by user:{me} WS notifications (spec §6.4/§7): market
// matched ("Your bet was taken."), order filled, new DM, post liked — plus a
// manual show() for local confirmations.

interface Toast {
  id: number;
  title: string;
  body?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  href?: string;
}

interface ToastApi {
  show: (t: Omit<Toast, "id">) => void;
}

const Ctx = createContext<ToastApi>({ show: () => {} });
export const useToasts = () => useContext(Ctx);

function toastForNotification(n: AppNotification): Omit<Toast, "id"> | null {
  const who = n.payload.user?.username ? `@${n.payload.user.username}` : "Someone";
  switch (n.kind) {
    case "market.matched":
      return {
        title: "Your bet was taken.",
        body: n.payload.title || n.payload.body,
        icon: "flash",
        href: n.payload.market_id ? `/market/${n.payload.market_id}` : undefined,
      };
    case "order.filled":
      return {
        title: "Order filled",
        body: n.payload.body,
        icon: "checkmark-circle",
        href: n.payload.market_id ? `/market/${n.payload.market_id}` : undefined,
      };
    case "dm.message":
      return {
        title: `${who} sent you a message`,
        body: n.payload.body,
        icon: "chatbubble",
        href: n.payload.conversation_id ? `/conversation/${n.payload.conversation_id}` : "/messages",
      };
    case "post.liked":
      return {
        title: `${who} liked your post`,
        icon: "heart",
        href: n.payload.post_id ? `/post/${n.payload.post_id}` : undefined,
      };
    case "post.mention":
      return {
        title: `${who} mentioned you`,
        body: n.payload.body,
        icon: "at",
        href: n.payload.post_id
          ? `/post/${n.payload.post_id}`
          : n.payload.market_id
            ? `/market/${n.payload.market_id}`
            : undefined,
      };
    case "position.swing":
      return {
        title: "Your position moved sharply",
        body: n.payload.body,
        icon: "trending-up",
        href: n.payload.market_id ? `/market/${n.payload.market_id}` : undefined,
      };
    case "following.large_entry":
      return {
        title: `${who} placed a big bet`,
        body: n.payload.body,
        icon: "rocket",
        href: n.payload.market_id
          ? `/market/${n.payload.market_id}`
          : n.payload.post_id
            ? `/post/${n.payload.post_id}`
            : undefined,
      };
    case "follow.request":
      return { title: `${who} requested to follow you`, icon: "person-add", href: "/notifications" };
    case "follow.new":
    case "follow":
      return { title: `${who} started following you`, icon: "person-add", href: n.payload.user?.username ? `/user/${n.payload.user.username}` : "/notifications" };
    default:
      return n.payload.title ? { title: n.payload.title, body: n.payload.body, icon: "notifications" } : null;
  }
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const { onUserEvent } = useSession();

  const show = useCallback((t: Omit<Toast, "id">) => {
    thud();
    const id = nextId.current++;
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), 4200);
  }, []);

  useEffect(
    () =>
      onUserEvent((e) => {
        if (e.type === "notification") {
          const t = toastForNotification(e.payload);
          if (t) show(t);
        }
      }),
    [onUserEvent, show]
  );

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <ToastStack toasts={toasts} dismiss={(id) => setToasts((all) => all.filter((x) => x.id !== id))} />
    </Ctx.Provider>
  );
}

function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: insets.top + 6, left: 12, right: 12, gap: 8 }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDone={() => dismiss(t.id)} />
      ))}
    </View>
  );
}

function ToastCard({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const t = useTheme();
  const router = useRouter();
  const y = useRef(new Animated.Value(-80)).current;
  useEffect(() => {
    Animated.spring(y, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
  }, [y]);
  return (
    <Animated.View style={{ transform: [{ translateY: y }] }}>
      <Pressable
        onPress={() => {
          onDone();
          if (toast.href) router.push(toast.href as never);
        }}
        style={{
          backgroundColor: t.mode === "dark" ? "#1C1C1E" : "#0A0A0A",
          borderRadius: radius.lg,
          paddingVertical: 12,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          shadowColor: "#000",
          shadowOpacity: 0.3,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 8,
        }}
      >
        <Ionicons name={toast.icon ?? "notifications"} size={20} color="#FFFFFF" />
        <View style={{ flex: 1 }}>
          <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 14 }} numberOfLines={1}>
            {toast.title}
          </Text>
          {toast.body ? (
            <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 12.5 }} numberOfLines={1}>
              {toast.body}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}
