import React from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListRowsSkeleton } from "../components/skeletons";
import { EmptyState, ErrorState } from "../components/states";
import { LogoRefreshList } from "../components/LogoRefresh";
import { Avatar } from "../components/ui";
import { useApi } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useSession } from "../lib/session";
import { space, useTheme } from "../lib/theme";
import { useGlobalWs } from "../lib/ws";
import { pageItems, type Conversation, type Message, type Paged } from "../lib/types";

// Conversations list (spec §7): the API inlines each conversation's most
// recent messages, and we seed those into the per-conversation query cache so
// opening a thread renders instantly (pre-fetch of top conversations).

export default function Messages() {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const { me } = useSession();

  const q = useQuery({
    queryKey: ["conversations"],
    queryFn: async () => {
      const res = await api.get<Paged<Conversation>>("/v1/conversations");
      // Seed thread caches for instant open.
      for (const c of pageItems<Conversation>(res)) {
        qc.setQueryData(["conversation-seed", c.id], c);
      }
      return res;
    },
  });

  // Live re-order on any new message.
  useGlobalWs((e) => {
    if (e.type === "message.new") q.refetch();
  });

  if (q.isLoading) return <ListRowsSkeleton rows={8} avatarSize={52} />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const conversations = pageItems<Conversation>(q.data);

  return (
    <LogoRefreshList<Conversation>
      style={{ backgroundColor: t.bg }}
      data={conversations}
      keyExtractor={(c) => c.id}
      refreshing={q.isRefetching}
      onRefresh={() => q.refetch()}
      ListEmptyComponent={
        <EmptyState icon="chatbubbles-outline" title="No messages yet" subtitle="Say hi to someone from their profile." />
      }
      contentContainerStyle={conversations.length === 0 ? { flexGrow: 1 } : undefined}
      renderItem={({ item }) => {
        const other = item.members.find((m) => m.id !== me?.id) ?? item.members[0];
        const last: Message | undefined = item.recent_messages[item.recent_messages.length - 1];
        const unread = item.unread_count > 0;
        return (
          <Pressable
            onPress={() => router.push(`/conversation/${item.id}` as never)}
            style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: space.md, paddingVertical: 12 }}
          >
            <Avatar url={other?.avatar_url} size={52} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: unread ? "800" : "600", fontSize: 15 }}>
                {other?.display_name || other?.username || "Conversation"}
              </Text>
              <Text style={{ color: unread ? t.text : t.textDim, fontSize: 13, fontWeight: unread ? "600" : "400" }} numberOfLines={1}>
                {last
                  ? (last.body ?? (last.shared_post || last.post_id ? "Shared a post" : last.media ? "📎 Attachment" : ""))
                  : "Start the conversation"}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 5 }}>
              {last ? <Text style={{ color: t.textFaint, fontSize: 11.5 }}>{timeAgo(last.created_at)}</Text> : null}
              {unread ? (
                <View style={{ backgroundColor: t.blue, minWidth: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 }}>
                  <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800" }}>{item.unread_count}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        );
      }}
    />
  );
}
