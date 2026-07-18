import React, { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, Text, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { Link, useRouter } from "expo-router";
import { useApi } from "../lib/api";
import { bestImageUrl } from "../lib/media";
import { compact, timeAgo } from "../lib/format";
import { tap } from "../lib/haptics";
import { radius, space, useTheme } from "../lib/theme";
import type { Post } from "../lib/types";
import { CommentsSheet } from "./CommentsSheet";
import { MarketCard } from "./MarketCard";
import { MentionText } from "./MentionText";
import { SharePostSheet } from "./SharePostSheet";
import { Avatar, DoubleTap } from "./ui";
import { VideoPlayer } from "./VideoPlayer";

// Feed post card (spec §7): author row, media carousel with paging dots,
// then the attached market card (full-bleed, persists after settlement showing
// the direction badge + poster PnL), then the like/comment/react/share row,
// caption, and comments preview.

const REACTIONS = ["🔥", "😂", "😮", "💯"];

function PostCardImpl({
  post,
  active,
  farFromActive,
}: {
  post: Post;
  active?: boolean;
  // True when the user has scrolled 2+ posts past this one: videos rewind to
  // the start so scrolling back replays from the beginning.
  farFromActive?: boolean;
}) {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const carouselRef = useRef<FlatList<Post["media"][number]>>(null);

  // Swipe works natively; the arrows make multi-item carousels pageable with
  // a mouse too (web/desktop, where drag-scrolling a list isn't a thing).
  const goTo = (i: number) => {
    const idx = Math.max(0, Math.min(post.media.length - 1, i));
    carouselRef.current?.scrollToIndex({ index: idx, animated: true });
    setPage(idx);
  };
  const [liked, setLiked] = useState(post.liked_by_me);
  const [likeCount, setLikeCount] = useState(post.like_count);
  const [myReaction, setMyReaction] = useState(post.my_reaction ?? null);
  const [page, setPage] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Feed videos start muted; a single tap on a video page toggles sound.
  const [videoMuted, setVideoMuted] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const pageIsVideo = post.media[page]?.kind === "video";

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
        (now ? api.put("/v1/likes", body) : api.delWithBody("/v1/likes", body)).catch(() => {
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
    (next
      ? api.put("/v1/reactions", body)
      : api.delWithBody("/v1/reactions", { subject_type: "post", subject_id: post.id, emoji })
    ).catch(() =>
      setMyReaction(prev)
    );
  };

  return (
    <View style={{ marginBottom: space.xl }}>
      {/* Author row — roomy vertical padding so it breathes next to the media
          above/below instead of hugging them. */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.md, paddingTop: 10, paddingBottom: 12, gap: 12 }}>
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

      {/* Media carousel. Single tap on a video page toggles mute; videos only
          play while the post clears the feed's >50%-visible threshold. */}
      {post.media.length > 0 ? (
        <DoubleTap
          onDoubleTap={() => toggleLike(true)}
          onSingleTap={pageIsVideo ? () => setVideoMuted((m) => !m) : undefined}
        >
          <FlatList
            ref={carouselRef}
            data={post.media}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(m) => m.id}
            getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
            onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
            renderItem={({ item, index }) =>
              item.kind === "video" ? (
                <VideoPlayer
                  media={item}
                  active={!!active && index === page}
                  muted={videoMuted}
                  rewind={!!farFromActive}
                  style={{ width, height: mediaH, backgroundColor: "#000" }}
                />
              ) : (
                <Image
                  source={{ uri: bestImageUrl(item, width) }}
                  style={{ width, height: mediaH, backgroundColor: t.surfaceAlt }}
                  contentFit="cover"
                  transition={150}
                />
              )
            }
          />
          {pageIsVideo ? (
            <View style={{ position: "absolute", bottom: 10, right: 10, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 13, padding: 5 }}>
              <Ionicons name={videoMuted ? "volume-mute" : "volume-high"} size={16} color="#fff" />
            </View>
          ) : null}
          {post.media.length > 1 ? (
            <>
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
              {page > 0 ? (
                <Pressable
                  onPress={() => goTo(page - 1)}
                  hitSlop={8}
                  style={{ position: "absolute", left: 8, top: "50%", marginTop: -16, backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 16, padding: 4 }}
                >
                  <Ionicons name="chevron-back" size={22} color="#fff" />
                </Pressable>
              ) : null}
              {page < post.media.length - 1 ? (
                <Pressable
                  onPress={() => goTo(page + 1)}
                  hitSlop={8}
                  style={{ position: "absolute", right: 8, top: "50%", marginTop: -16, backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 16, padding: 4 }}
                >
                  <Ionicons name="chevron-forward" size={22} color="#fff" />
                </Pressable>
              ) : null}
            </>
          ) : null}
        </DoubleTap>
      ) : null}

      {/* Attached market card: full-bleed and flush against the media above,
          between the media and the action row (stays attached after
          settlement). */}
      {post.market ? (
        <View>
          <MarketCard
            market={post.market}
            affiliatePostId={post.id}
            affiliateId={post.affiliate_id}
            posterPosition={post.author_position}
            posterPnl={post.author_pnl}
            posterUsername={post.author.username}
            fullBleed
          />
        </View>
      ) : null}

      {/* Action row */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.md, paddingTop: 10, gap: 16 }}>
        <Pressable onPress={() => toggleLike()} hitSlop={6} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Ionicons name={liked ? "heart" : "heart-outline"} size={26} color={liked ? t.no : t.text} />
          {likeCount > 0 ? <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 13 }}>{compact(likeCount)}</Text> : null}
        </Pressable>
        <Pressable
          onPress={() => {
            tap();
            setCommentsOpen(true);
          }}
          hitSlop={6}
          style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
        >
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
          onPress={() => {
            tap();
            setShareOpen(true);
          }}
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
          <MentionText caption={post.caption} mentions={post.mentions} />
        </Text>
      ) : null}

      {/* Comments preview — opens the bottom-sheet thread, not a new page. */}
      {post.comment_count > 0 ? (
        <Pressable onPress={() => setCommentsOpen(true)} style={{ paddingHorizontal: space.md, paddingTop: 6, gap: 3 }}>
          <Text style={{ color: t.textFaint, fontSize: 13 }}>
            View all {compact(post.comment_count)} comments
          </Text>
          {(post.top_comments ?? []).slice(0, 2).map((c) => (
            <Text key={c.id} style={{ color: t.text, fontSize: 13.5 }} numberOfLines={1}>
              <Text style={{ fontWeight: "700" }}>{c.author.username} </Text>
              {c.body}
            </Text>
          ))}
        </Pressable>
      ) : null}

      <SharePostSheet post={post} visible={shareOpen} onClose={() => setShareOpen(false)} />
      <CommentsSheet postId={post.id} visible={commentsOpen} onClose={() => setCommentsOpen(false)} />
    </View>
  );
}

// Memoized: feed rows only re-render when their post object or active state
// changes, keeping large-list scrolling smooth.
export const PostCard = React.memo(PostCardImpl);
