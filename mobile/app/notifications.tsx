import React, { useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { Avatar, Button } from "../components/ui";
import { useApi } from "../lib/api";
import { timeAgo } from "../lib/format";
import { success, tap } from "../lib/haptics";
import { useSession } from "../lib/session";
import { space, useTheme } from "../lib/theme";
import { nextCursorOf, pageItems, type AppNotification, type FollowRequest, type Paged } from "../lib/types";

// Notifications (spec §7): follow-requests surface (approve/deny for private
// accounts) atop the notification list; opening marks everything read.

export default function Notifications() {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const { refreshBadges, onUserEvent } = useSession();

  const q = useInfiniteQuery({
    queryKey: ["notifications"],
    queryFn: ({ pageParam }) =>
      api.get<Paged<AppNotification>>(`/v1/notifications?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  const requests = useQuery({
    queryKey: ["follow-requests"],
    queryFn: () => api.get<Paged<FollowRequest>>("/v1/me/follow-requests"),
  });

  // Mark read on open; keep the list live.
  useEffect(() => {
    api.post("/v1/notifications/read").then(refreshBadges).catch(() => {});
  }, [api, refreshBadges]);
  useEffect(
    () =>
      onUserEvent((e) => {
        if (e.type === "notification") {
          qc.invalidateQueries({ queryKey: ["notifications"] });
          if (e.payload.kind === "follow.request") qc.invalidateQueries({ queryKey: ["follow-requests"] });
        }
      }),
    [onUserEvent, qc]
  );

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const items = q.data?.pages.flatMap((p) => pageItems<AppNotification>(p)) ?? [];
  const reqs = pageItems<FollowRequest>(requests.data);

  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      data={items}
      keyExtractor={(n) => n.id}
      ListHeaderComponent={reqs.length > 0 ? <FollowRequests requests={reqs} /> : null}
      renderItem={({ item }) => <NotificationRow n={item} />}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
      onEndReachedThreshold={0.4}
      refreshing={q.isRefetching && !q.isFetchingNextPage}
      onRefresh={() => {
        q.refetch();
        requests.refetch();
      }}
      ListEmptyComponent={
        reqs.length === 0 ? (
          <EmptyState icon="notifications-outline" title="Nothing yet" subtitle="Likes, fills, and matched bets land here." />
        ) : null
      }
      contentContainerStyle={items.length === 0 && reqs.length === 0 ? { flexGrow: 1 } : undefined}
    />
  );

  function NotificationRow({ n }: { n: AppNotification }) {
    const icon: keyof typeof Ionicons.glyphMap =
      n.kind === "market.matched"
        ? "flash"
        : n.kind === "order.filled"
          ? "checkmark-circle"
          : n.kind === "dm.message"
            ? "chatbubble"
            : n.kind === "post.liked"
              ? "heart"
              : n.kind.startsWith("follow")
                ? "person-add"
                : "notifications";
    const title =
      n.payload.title ??
      (n.kind === "market.matched"
        ? "Your bet was taken."
        : n.kind === "order.filled"
          ? "Order filled"
          : n.kind === "post.liked"
            ? `@${n.payload.user?.username ?? "someone"} liked your post`
            : n.kind);
    const href = n.payload.market_id
      ? `/market/${n.payload.market_id}`
      : n.payload.post_id
        ? `/post/${n.payload.post_id}`
        : n.payload.conversation_id
          ? `/conversation/${n.payload.conversation_id}`
          : n.payload.user?.username
            ? `/user/${n.payload.user.username}`
            : null;
    return (
      <Pressable
        onPress={() => href && router.push(href as never)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: space.md,
          paddingVertical: 12,
          backgroundColor: n.read_at ? "transparent" : t.blueTint,
        }}
      >
        {n.payload.user ? (
          <Avatar url={n.payload.user.avatar_url} size={40} />
        ) : (
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name={icon} size={19} color={t.blue} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 14, fontWeight: n.read_at ? "500" : "700" }}>{title}</Text>
          {n.payload.body ? (
            <Text style={{ color: t.textDim, fontSize: 12.5 }} numberOfLines={1}>
              {n.payload.body}
            </Text>
          ) : null}
        </View>
        <Text style={{ color: t.textFaint, fontSize: 11.5 }}>{timeAgo(n.created_at)}</Text>
      </Pressable>
    );
  }
}

function FollowRequests({ requests }: { requests: FollowRequest[] }) {
  const api = useApi();
  const t = useTheme();
  const qc = useQueryClient();
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const act = async (id: string, action: "approve" | "deny") => {
    tap();
    setHidden((s) => new Set(s).add(id));
    try {
      await api.post(`/v1/follow-requests/${id}/${action}`);
      if (action === "approve") success();
      qc.invalidateQueries({ queryKey: ["follow-requests"] });
    } catch {
      setHidden((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  const visible = requests.filter((r) => !hidden.has(r.id));
  if (visible.length === 0) return null;

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: t.border, paddingBottom: 6 }}>
      <Text style={{ color: t.textDim, fontWeight: "800", fontSize: 12, letterSpacing: 0.7, padding: space.md, paddingBottom: 4 }}>
        FOLLOW REQUESTS
      </Text>
      {visible.map((r) => (
        <View key={r.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: space.md, paddingVertical: 8 }}>
          <Avatar url={r.user.avatar_url} size={44} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontWeight: "700", fontSize: 14 }}>@{r.user.username}</Text>
            <Text style={{ color: t.textFaint, fontSize: 12 }}>{timeAgo(r.created_at)}</Text>
          </View>
          <Button title="Approve" small onPress={() => act(r.id, "approve")} />
          <Button title="Deny" small variant="subtle" onPress={() => act(r.id, "deny")} />
        </View>
      ))}
    </View>
  );
}
