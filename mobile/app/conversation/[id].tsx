import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Animated } from "react-native";
import { VideoPlayer } from "../../components/VideoPlayer";
import { Avatar } from "../../components/ui";
import { Loading } from "../../components/states";
import { useApi } from "../../lib/api";
import { tap } from "../../lib/haptics";
import { useSession } from "../../lib/session";
import { radius, space, useTheme } from "../../lib/theme";
import { useDmChannel } from "../../lib/ws";
import { nextCursorOf, pageItems, type Conversation, type Message, type Paged, type UserProfile } from "../../lib/types";

// Conversation thread (spec §7): opens instantly from the inlined recent
// messages, live WS messages, animated typing bubbles (typing.start/stop),
// photo/video attachments (picker → presign upload → inline render/HLS),
// reactions (double-tap ❤️), and read receipts.

const MSG_REACTIONS = ["❤️", "😂", "🔥", "👍"];

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const t = useTheme();
  const qc = useQueryClient();
  const navigation = useNavigation();
  const { me, refreshBadges } = useSession();

  const seed = qc.getQueryData<Conversation>(["conversation-seed", id]);
  const [messages, setMessages] = useState<Message[]>(() =>
    [...(seed?.recent_messages ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  );
  const [loading, setLoading] = useState(!seed);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [typers, setTypers] = useState<UserProfile[]>([]);
  const [reactFor, setReactFor] = useState<string | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);

  const other = seed?.members.find((m) => m.id !== me?.id);
  // Read receipts derive from the other member's last_read_at (web parity).
  const [otherLastRead, setOtherLastRead] = useState<string | null>(other?.last_read_at ?? null);

  useEffect(() => {
    navigation.setOptions({ title: other?.display_name || other?.username || "Conversation" });
  }, [navigation, other]);

  // Initial page (newest first).
  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.get<Paged<Message>>(`/v1/conversations/${id}/messages?limit=30`);
      setMessages(pageItems<Message>(res));
      setCursor(nextCursorOf(res));
      setHasMore(!!nextCursorOf(res));
      // Mark read.
      api.post(`/v1/conversations/${id}/read`).catch(() => {});
      refreshBadges();
    } catch {
      /* seed keeps rendering */
    } finally {
      setLoading(false);
    }
  }, [api, id, refreshBadges]);
  useEffect(() => {
    load();
  }, [load]);

  const loadOlder = async () => {
    if (!hasMore || !cursor || !id) return;
    const res = await api.get<Paged<Message>>(
      `/v1/conversations/${id}/messages?limit=30&cursor=${encodeURIComponent(cursor)}`
    );
    setMessages((cur) => [...cur, ...pageItems<Message>(res)]);
    setCursor(nextCursorOf(res));
    setHasMore(!!nextCursorOf(res));
  };

  // Live channel: new messages, typing bubbles, read receipts.
  const { sendTyping } = useDmChannel(id ?? null, (e) => {
    if (e.type === "message.new") {
      const msg = e.payload;
      setMessages((cur) => (cur.some((m) => m.id === msg.id) ? cur : [msg, ...cur]));
      setTypers((cur) => cur.filter((u) => u.id !== msg.sender.id));
      if (msg.sender.id !== me?.id && id) {
        api.post(`/v1/conversations/${id}/read`).catch(() => {});
      }
    } else if (e.type === "typing.start") {
      const u = e.payload.user;
      if (u.id !== me?.id) {
        setTypers((cur) => (cur.some((x) => x.id === u.id) ? cur : [...cur, u]));
      }
    } else if (e.type === "typing.stop") {
      setTypers((cur) => cur.filter((u) => u.id !== e.payload.user.id));
    } else if (e.type === "read") {
      // Member read state moved forward (conversation_members.last_read_at).
      if (e.payload.user_id !== me?.id) setOtherLastRead(e.payload.at);
    } else if (e.type === "message.reaction") {
      setMessages((cur) =>
        cur.map((m) => (m.id === e.payload.message_id ? { ...m, reactions: e.payload.reactions } : m))
      );
    }
  });

  const onType = (v: string) => {
    setText(v);
    const now = Date.now();
    if (now - lastTypingSent.current > 2500) {
      lastTypingSent.current = now;
      sendTyping(true);
    }
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => sendTyping(false), 3000);
  };

  const send = async (mediaId?: string) => {
    const body = text.trim();
    if (!body && !mediaId) return;
    setSending(true);
    sendTyping(false);
    const optimistic: Message = {
      id: `tmp-${Date.now()}`,
      conversation_id: id!,
      sender: {
        id: me!.id,
        username: me!.username ?? "",
        display_name: me!.display_name,
        avatar_url: me!.avatar_url,
        bio: null,
        links: null,
        is_private: false,
        post_count: 0,
        follower_count: 0,
        following_count: 0,
      },
      body: body || null,
      created_at: new Date().toISOString(),
      pending: true,
    };
    if (!mediaId) setMessages((cur) => [optimistic, ...cur]);
    setText("");
    try {
      const res = await api.post<{ message: Message }>(`/v1/conversations/${id}/messages`, {
        body: body || null,
        media_id: mediaId ?? null,
      });
      setMessages((cur) => [res.message, ...cur.filter((m) => m.id !== optimistic.id)]);
    } catch {
      setMessages((cur) => cur.filter((m) => m.id !== optimistic.id));
      setText(body);
    } finally {
      setSending(false);
    }
  };

  const attach = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.85,
    });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    setSending(true);
    try {
      const up = await api.uploadMedia(a.uri, a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"));
      await send(up.id);
    } finally {
      setSending(false);
    }
  };

  const react = (messageId: string, emoji: string) => {
    tap();
    setReactFor(null);
    api.put("/v1/reactions", { subject_type: "message", subject_id: messageId, emoji }).catch(() => {});
  };

  if (loading && messages.length === 0) return <Loading />;

  const lastMineIdx = messages.findIndex((m) => m.sender.id === me?.id);
  const lastMine = lastMineIdx >= 0 ? messages[lastMineIdx] : undefined;
  const seenByOther = !!lastMine && !!otherLastRead && otherLastRead >= lastMine.created_at;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.bg }} keyboardVerticalOffset={92}>
      <FlatList
        data={messages}
        inverted
        keyExtractor={(m) => m.id}
        onEndReached={loadOlder}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View>
            {typers.length > 0 ? <TypingBubble user={typers[0]} /> : null}
            {seenByOther ? (
              <Text style={{ color: t.textFaint, fontSize: 11, textAlign: "right", paddingHorizontal: space.lg, paddingBottom: 4 }}>
                Seen
              </Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            mine={item.sender.id === me?.id}
            showReactions={reactFor === item.id}
            onLongPress={() => setReactFor((cur) => (cur === item.id ? null : item.id))}
            onReact={(e) => react(item.id, e)}
          />
        )}
        contentContainerStyle={{ paddingVertical: 12 }}
      />

      {/* Composer */}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, padding: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
        <Pressable onPress={attach} hitSlop={8} style={{ paddingBottom: 8 }}>
          <Ionicons name="image-outline" size={26} color={t.textDim} />
        </Pressable>
        <TextInput
          style={{
            flex: 1,
            backgroundColor: t.surfaceAlt,
            color: t.text,
            borderRadius: 22,
            paddingHorizontal: 16,
            paddingVertical: 10,
            fontSize: 15,
            maxHeight: 120,
          }}
          placeholder="Message…"
          placeholderTextColor={t.textFaint}
          value={text}
          onChangeText={onType}
          multiline
        />
        <Pressable onPress={() => send()} disabled={sending || !text.trim()} hitSlop={8} style={{ paddingBottom: 2 }}>
          <Ionicons name="arrow-up-circle" size={36} color={text.trim() ? t.blue : t.textFaint} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({
  message,
  mine,
  showReactions,
  onLongPress,
  onReact,
}: {
  message: Message;
  mine: boolean;
  showReactions: boolean;
  onLongPress: () => void;
  onReact: (emoji: string) => void;
}) {
  const t = useTheme();
  const reactions = Object.entries(message.reactions ?? {}).filter(([, n]) => n > 0);
  return (
    <View style={{ paddingHorizontal: space.md, marginVertical: 3, alignItems: mine ? "flex-end" : "flex-start" }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, maxWidth: "82%" }}>
        {!mine ? <Avatar url={message.sender.avatar_url} size={26} /> : null}
        <Pressable
          onLongPress={onLongPress}
          delayLongPress={250}
          style={{
            backgroundColor: mine ? t.blue : t.surfaceAlt,
            borderRadius: 18,
            borderBottomRightRadius: mine ? 5 : 18,
            borderBottomLeftRadius: mine ? 18 : 5,
            overflow: "hidden",
            opacity: message.pending ? 0.6 : 1,
          }}
        >
          {message.media ? (
            message.media.kind === "video" ? (
              <VideoPlayer media={message.media} active={false} muted style={{ width: 220, height: 280 }} />
            ) : (
              <Image source={{ uri: message.media.url }} style={{ width: 220, height: 280 }} contentFit="cover" />
            )
          ) : null}
          {message.body ? (
            <Text style={{ color: mine ? "#fff" : t.text, fontSize: 15, lineHeight: 20, paddingHorizontal: 14, paddingVertical: 9 }}>
              {message.body}
            </Text>
          ) : null}
        </Pressable>
      </View>
      {reactions.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 4, marginTop: 2, marginHorizontal: 34 }}>
          {reactions.map(([e, n]) => (
            <Text key={e} style={{ fontSize: 12.5, color: t.textDim }}>
              {e}
              {n > 1 ? ` ${n}` : ""}
            </Text>
          ))}
        </View>
      ) : null}
      {showReactions ? (
        <View
          style={{
            flexDirection: "row",
            gap: 10,
            backgroundColor: t.surfaceAlt,
            borderRadius: radius.full,
            paddingVertical: 6,
            paddingHorizontal: 12,
            marginTop: 4,
          }}
        >
          {MSG_REACTIONS.map((e) => (
            <Pressable key={e} onPress={() => onReact(e)}>
              <Text style={{ fontSize: 20 }}>{e}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// Animated three-dot typing bubble.
function TypingBubble({ user }: { user: UserProfile }) {
  const t = useTheme();
  const dots = [useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current];
  useEffect(() => {
    const anims = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(d, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(d, { toValue: 0.3, duration: 320, useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ])
      )
    );
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: space.md, marginVertical: 6 }}>
      <Avatar url={user.avatar_url} size={26} />
      <View
        style={{
          backgroundColor: t.surfaceAlt,
          borderRadius: 18,
          borderBottomLeftRadius: 5,
          paddingHorizontal: 14,
          paddingVertical: 12,
          flexDirection: "row",
          gap: 4,
        }}
      >
        {dots.map((d, i) => (
          <Animated.View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.textDim, opacity: d }} />
        ))}
      </View>
    </View>
  );
}
