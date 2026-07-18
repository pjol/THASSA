import React, { useState } from "react";
import { Pressable, Share, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { errorMessage, postShareUrl, useApi } from "../lib/api";
import { tap } from "../lib/haptics";
import { useSession } from "../lib/session";
import { radius, space, useTheme } from "../lib/theme";
import { pageItems, type Conversation, type Paged, type Post } from "../lib/types";
import { useToasts } from "./Toasts";
import { Avatar, Sheet } from "./ui";

// Post share sheet: send the post into a DM as a tappable post card, or share
// an external https link through the OS share sheet.

export function SharePostSheet({
  post,
  visible,
  onClose,
}: {
  post: Post;
  visible: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const t = useTheme();
  const toasts = useToasts();
  const { me } = useSession();
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["conversations", "share"],
    enabled: visible,
    queryFn: () => api.get<Paged<Conversation>>("/v1/conversations?limit=15"),
  });
  const conversations = pageItems<Conversation>(q.data).filter((c) => c.kind === "dm");

  const sendTo = async (conv: Conversation) => {
    if (sentTo.has(conv.id) || busy) return;
    tap();
    setBusy(conv.id);
    try {
      await api.post(`/v1/conversations/${conv.id}/messages`, { post_id: post.id });
      setSentTo((cur) => new Set(cur).add(conv.id));
    } catch (e) {
      toasts.show({ title: "Couldn't send", body: errorMessage(e), icon: "alert-circle" });
    } finally {
      setBusy(null);
    }
  };

  const shareExternal = async () => {
    const url = postShareUrl(post.id);
    try {
      await Share.share({ message: url, url });
    } catch {
      /* user dismissed */
    }
  };

  const otherOf = (c: Conversation) => c.members.find((m) => m.id !== me?.id) ?? c.members[0];

  return (
    <Sheet visible={visible} onClose={onClose} title="Share post">
      <View style={{ gap: space.md }}>
        {/* DM targets */}
        {conversations.length > 0 ? (
          <View style={{ gap: 2 }}>
            {conversations.map((c) => {
              const other = otherOf(c);
              const sent = sentTo.has(c.id);
              return (
                <Pressable
                  key={c.id}
                  onPress={() => sendTo(c)}
                  disabled={sent}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingVertical: 9,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Avatar url={other?.avatar_url} size={40} />
                  <Text style={{ color: t.text, fontWeight: "700", fontSize: 14.5, flex: 1 }}>
                    {other?.username ?? "conversation"}
                  </Text>
                  <View
                    style={{
                      backgroundColor: sent ? t.grayTint : t.blue,
                      borderRadius: radius.full,
                      paddingVertical: 7,
                      paddingHorizontal: 16,
                      minWidth: 68,
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: sent ? t.textDim : "#fff", fontWeight: "800", fontSize: 13 }}>
                      {sent ? "Sent" : busy === c.id ? "…" : "Send"}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={{ color: t.textDim, fontSize: 13.5 }}>
            {q.isLoading ? "Loading conversations…" : "No conversations yet. Start one from a profile."}
          </Text>
        )}

        {/* External link */}
        <Pressable
          onPress={shareExternal}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 12,
            borderTopWidth: 1,
            borderTopColor: t.border,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: t.grayTint,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="link-outline" size={20} color={t.text} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontWeight: "700", fontSize: 14.5 }}>Share link</Text>
            <Text style={{ color: t.textFaint, fontSize: 12 }} numberOfLines={1}>
              {postShareUrl(post.id)}
            </Text>
          </View>
          <Ionicons name="share-outline" size={18} color={t.textDim} />
        </Pressable>
      </View>
    </Sheet>
  );
}
