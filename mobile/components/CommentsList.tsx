import React, { useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../lib/api";
import { compact, timeAgo } from "../lib/format";
import { tap } from "../lib/haptics";
import { computeMentions, type DraftMention } from "../lib/mentions";
import { space, useTheme } from "../lib/theme";
import { nextCursorOf, pageItems, type Comment, type Paged } from "../lib/types";
import { MentionInput } from "./MentionInput";
import { MentionText } from "./MentionText";
import { ListRowsSkeleton } from "./skeletons";
import { BrandRefreshControl, EmptyState } from "./states";
import { Avatar } from "./ui";

// Comments with likes and replies — the same surface for posts and markets
// (spec §6.2: a comment attaches to a post OR a market).

export function CommentsList({
  subjectType,
  subjectId,
  header,
}: {
  subjectType: "post" | "market";
  subjectId: string;
  header?: React.ReactElement;
}) {
  const api = useApi();
  const t = useTheme();
  const qc = useQueryClient();
  const base = subjectType === "post" ? `/v1/posts/${subjectId}/comments` : `/v1/markets/${subjectId}/comments`;
  const [body, setBody] = useState("");
  const [mentionDrafts, setMentionDrafts] = useState<DraftMention[]>([]);
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [sending, setSending] = useState(false);

  const key = ["comments", subjectType, subjectId];
  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) =>
      api.get<Paged<Comment>>(`${base}?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  const comments = q.data?.pages.flatMap((p) => pageItems<Comment>(p)) ?? [];

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    tap();
    try {
      await api.post(base, {
        body: text,
        parent_id: replyTo?.id ?? null,
        mentions: computeMentions(text, mentionDrafts),
      });
      setBody("");
      setMentionDrafts([]);
      setReplyTo(null);
      qc.invalidateQueries({ queryKey: key });
    } catch {
      /* keep the text so the user can retry */
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }} keyboardVerticalOffset={90}>
      <FlatList
        data={comments}
        keyExtractor={(c) => c.id}
        ListHeaderComponent={header}
        renderItem={({ item }) => <CommentRow comment={item} onReply={() => setReplyTo(item)} />}
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          q.isLoading ? (
            <ListRowsSkeleton rows={4} avatarSize={32} />
          ) : (
            <EmptyState icon="chatbubble-outline" title="No comments yet" subtitle="Say something." />
          )
        }
        contentContainerStyle={{ paddingBottom: 12, flexGrow: 1 }}
        refreshControl={
          <BrandRefreshControl
            refreshing={q.isRefetching && !q.isFetchingNextPage}
            onRefresh={() => q.refetch()}
          />
        }
      />
      <View style={{ borderTopWidth: 1, borderTopColor: t.border, padding: space.md, gap: 6 }}>
        {replyTo ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: t.textDim, fontSize: 12.5 }}>
              Replying to <Text style={{ fontWeight: "700" }}>@{replyTo.author.username}</Text>
            </Text>
            <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={t.textFaint} />
            </Pressable>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10 }}>
          <MentionInput
            containerStyle={{ flex: 1 }}
            listPosition="above"
            value={body}
            onChangeText={setBody}
            drafts={mentionDrafts}
            onDraftsChange={setMentionDrafts}
            inputStyle={{
              backgroundColor: t.surfaceAlt,
              color: t.text,
              borderRadius: 22,
              paddingHorizontal: 16,
              paddingVertical: 10,
              fontSize: 15,
            }}
            placeholder="Add a comment… @mention"
            placeholderTextColor={t.textFaint}
            multiline
          />
          <Pressable onPress={send} disabled={!body.trim() || sending} hitSlop={8} style={{ paddingBottom: 4 }}>
            <Ionicons name="arrow-up-circle" size={34} color={body.trim() ? t.blue : t.textFaint} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function CommentRow({ comment, onReply, isReply }: { comment: Comment; onReply: () => void; isReply?: boolean }) {
  const t = useTheme();
  const api = useApi();
  const [liked, setLiked] = useState(comment.liked_by_me);
  const [likes, setLikes] = useState(comment.like_count);
  const [showReplies, setShowReplies] = useState(false);

  const toggleLike = () => {
    tap();
    const now = !liked;
    setLiked(now);
    setLikes((n) => n + (now ? 1 : -1));
    const body = { subject_type: "comment", subject_id: comment.id };
    (now ? api.put("/v1/likes", body) : api.delWithBody("/v1/likes", body)).catch(() => {
      setLiked(!now);
      setLikes((n) => n + (now ? -1 : 1));
    });
  };

  return (
    <View style={{ paddingHorizontal: space.md, paddingVertical: 8, paddingLeft: isReply ? space.xl + space.md : space.md }}>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Avatar url={comment.author.avatar_url} size={isReply ? 26 : 32} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 13.5, lineHeight: 18 }}>
            <Text style={{ fontWeight: "700" }}>{comment.author.username} </Text>
            <MentionText caption={comment.body} mentions={comment.mentions} />
          </Text>
          <View style={{ flexDirection: "row", gap: 14, marginTop: 3 }}>
            <Text style={{ color: t.textFaint, fontSize: 11.5 }}>{timeAgo(comment.created_at)}</Text>
            {!isReply ? (
              <Pressable onPress={onReply} hitSlop={6}>
                <Text style={{ color: t.textFaint, fontSize: 11.5, fontWeight: "700" }}>Reply</Text>
              </Pressable>
            ) : null}
          </View>
          {!isReply && (comment.reply_count ?? comment.replies?.length ?? 0) > 0 ? (
            <Pressable onPress={() => setShowReplies((s) => !s)} style={{ marginTop: 4 }}>
              <Text style={{ color: t.textDim, fontSize: 12, fontWeight: "700" }}>
                {showReplies ? "Hide replies" : `View ${comment.reply_count ?? comment.replies?.length} replies`}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable onPress={toggleLike} hitSlop={6} style={{ alignItems: "center", gap: 2 }}>
          <Ionicons name={liked ? "heart" : "heart-outline"} size={16} color={liked ? t.no : t.textFaint} />
          {likes > 0 ? <Text style={{ color: t.textFaint, fontSize: 10.5 }}>{compact(likes)}</Text> : null}
        </Pressable>
      </View>
      {showReplies
        ? (comment.replies ?? []).map((r) => <CommentRow key={r.id} comment={r} onReply={onReply} isReply />)
        : null}
    </View>
  );
}
