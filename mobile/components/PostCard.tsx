import React, { useCallback, useState } from "react";
import { FlatList, Pressable, Share, Text, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { Link, useRouter } from "expo-router";
import { useApi } from "../lib/api";
import { compact, displayName, timeAgo } from "../lib/format";
import { tap } from "../lib/haptics";
import { radius, space, useTheme } from "../lib/theme";
import type { Post } from "../lib/types";
import { MarketCard } from "./MarketCard";
import { Avatar, DoubleTap } from "./ui";
import { VideoPlayer } from "./VideoPlayer";

// Feed post card (spec §7): author row, media carousel with paging dots,
// double-tap like, like/comment/react/share row, caption, comments preview,
// and the attached market card (which persists after settlement showing the
// direction badge + poster PnL).

const REACTIONS = ["🔥", "😂", "😮", "💯"];

export function PostCard({ post, active }: { post: Post; active?: boolean }) {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [liked, setLiked] = useState(post.liked_by_me);
  const [likeCount, setLikeCount] = useState(post.like_count);
  const [myReaction, setMyReaction] = useState(post.my_reaction ?? null);
  const [page, setPage] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  const mediaH = Math.min(width * 1.25, 560);

  // Optimistic like toggle.
  const toggleLike = useCallback(
    (forceOn = false) => {
      tap();
      setLiked((was) => {
        const now = forceOn ? true : !was;
        if (now === was) return was;
        setLikeCount((n) => n + (now ? 1 : -1));
        const body = { subject_type: "post", subject_id: post.id };
        (now ? api.put("/v1/likes", body) : api.del(`/v1/likes?subject_type=post&subject_id=${post.id}`)).catch(() => {
          setLiked(was);
          setLikeCount((n) => n + (now ? -1 : 1));
        });
        return now;
      });
    },
    [api, post.id]
  );

  const react = (emoji: string) => {
    tap();
    setPickerOpen(false);
    const prev = myReaction;
    const next = prev === emoji ? null : emoji;
    setMyReaction(next);
    const body = { subject_type: "post", subject_id: post.id, emoji };
    (next ? api.put("/v1/reactions", body) : api.del(`/v1/reactions?subject_type=post&subject_id=${post.id}`)).catch(() =>
      setMyReaction(prev)
    );
  };

  return (
    <View style={{ marginBottom: space.xl }}>
      {/* Author row */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.md, paddingBottom: 8, gap: 10 }}>
        <Link href={`/user/${post.author.username}` as never} asChild>
          <Pressable style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Avatar url={post.author.avatar_url} size={36} />
            <View>
              <Text style={{ color: t.text, fontWeight: "700", fontSize: 14 }}>{post.author.username}</Text>
              <Text style={{ color: t.textFaint, fontSize: 11.5 }}>{timeAgo(post.created_at)}</Text>
            </View>
          </Pressable>
        </Link>
        <View style={{ flex: 1 }} />
        {post.market ? <Ionicons name="stats-chart" size={16} color={t.blue} /> : null}
      </View>

      {/* Media carousel */}
      {post.media.length > 0 ? (
        <DoubleTap onDoubleTap={() => toggleLike(true)}>
          <FlatList
            data={post.media}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(m) => m.id}
            onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
            renderItem={({ item, index }) =>
              item.kind === "video" ? (
                <VideoPlayer
                  media={item}
                  active={!!active && index === page}
                  muted
                  style={{ width, height: mediaH, backgroundColor: "#000" }}
                />
              ) : (
                <Image
                  source={{ uri: item.url }}
                  style={{ width, height: mediaH, backgroundColor: t.surfaceAlt }}
                  contentFit="cover"
                  transition={150}
                />
              )
            }
          />
          {post.media.length > 1 ? (
            <View style={{ position: "absolute", bottom: 10, alignSelf: "center", flexDirection: "row", gap: 5 }}>
              {post.media.map((_, i) => (
                <View
                  key={i}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: i === page ? t.blue : "rgba(255,255,255,0.6)",
                  }}
                />
              ))}
            </View>
          ) : null}
        </DoubleTap>
      ) : null}

      {/* Action row */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.md, paddingTop: 10, gap: 16 }}>
        <Pressable onPress={() => toggleLike()} hitSlop={6} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Ionicons name={liked ? "heart" : "heart-outline"} size={26} color={liked ? t.no : t.text} />
          {likeCount > 0 ? <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 13 }}>{compact(likeCount)}</Text> : null}
        </Pressable>
        <Pressable onPress={() => router.push(`/post/${post.id}` as never)} hitSlop={6} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Ionicons name="chatbubble-outline" size={24} color={t.text} />
          {post.comment_count > 0 ? (
            <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 13 }}>{compact(post.comment_count)}</Text>
          ) : null}
        </Pressable>
        <Pressable onPress={() => setPickerOpen((o) => !o)} hitSlop={6}>
          {myReaction ? (
            <Text style={{ fontSize: 22 }}>{myReaction}</Text>
          ) : (
            <Ionicons name="happy-outline" size={25} color={t.text} />
          )}
        </Pressable>
        <Pressable
          onPress={() => Share.share({ message: `thassa://post/${post.id}` }).catch(() => {})}
          hitSlop={6}
        >
          <Ionicons name="paper-plane-outline" size={24} color={t.text} />
        </Pressable>
        <View style={{ flex: 1 }} />
      </View>
      {pickerOpen ? (
        <View
          style={{
            flexDirection: "row",
            gap: 14,
            marginHorizontal: space.md,
            marginTop: 8,
            backgroundColor: t.surfaceAlt,
            borderRadius: radius.full,
            paddingVertical: 8,
            paddingHorizontal: 16,
            alignSelf: "flex-start",
          }}
        >
          {REACTIONS.map((e) => (
            <Pressable key={e} onPress={() => react(e)}>
              <Text style={{ fontSize: 24, opacity: myReaction === e ? 1 : 0.75 }}>{e}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Caption */}
      {post.caption ? (
        <Text style={{ color: t.text, paddingHorizontal: space.md, paddingTop: 8, fontSize: 14, lineHeight: 19 }}>
          <Text style={{ fontWeight: "700" }}>{post.author.username} </Text>
          {post.caption}
        </Text>
      ) : null}

      {/* Comments preview */}
      {post.comment_count > 0 ? (
        <Pressable onPress={() => router.push(`/post/${post.id}` as never)} style={{ paddingHorizontal: space.md, paddingTop: 6, gap: 3 }}>
          <Text style={{ color: t.textFaint, fontSize: 13 }}>
            View all {compact(post.comment_count)} comments
          </Text>
          {(post.top_comments ?? []).slice(0, 2).map((c) => (
            <Text key={c.id} style={{ color: t.text, fontSize: 13.5 }} numberOfLines={1}>
              <Text style={{ fontWeight: "700" }}>{displayName(c.author)} </Text>
              {c.body}
            </Text>
          ))}
        </Pressable>
      ) : null}

      {/* Attached market card (stays attached after settlement). */}
      {post.market ? (
        <View style={{ paddingHorizontal: space.md, paddingTop: 10 }}>
          <MarketCard
            market={post.market}
            affiliatePostId={post.id}
            affiliateId={post.affiliate_id}
            posterPosition={post.author_position}
            posterPnl={post.author_pnl}
            posterUsername={post.author.username}
          />
        </View>
      ) : null}
    </View>
  );
}
