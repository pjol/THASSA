import React, { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, Text, useWindowDimensions, View, ViewToken } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useInfiniteQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, Loading } from "../../components/states";
import { Avatar } from "../../components/ui";
import { VideoPlayer } from "../../components/VideoPlayer";
import { useApi } from "../../lib/api";
import { compact } from "../../lib/format";
import { posterUrl } from "../../lib/media";
import { registerScrollToTop } from "../../lib/scrollToTop";
import { tap } from "../../lib/haptics";
import { useTheme } from "../../lib/theme";
import { nextCursorOf, pageItems, type Paged, type Post } from "../../lib/types";

// Reels (spec §7): full-screen vertical pager of HLS videos, autoplay on the
// visible page, like/comment overlays, infinite scroll.

export default function Reels() {
  const api = useApi();
  const t = useTheme();
  const { height: windowH, width } = useWindowDimensions();
  // Tab screens stay mounted — playback must stop when Watch loses focus.
  const focused = useIsFocused();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  // Actual list viewport height (window minus tab bar). Paging math MUST use
  // this — snapping to the window height drifts a little further each page,
  // showing slivers of two reels instead of the next one.
  const [viewH, setViewH] = useState(windowH);

  const q = useInfiniteQuery({
    queryKey: ["reels"],
    queryFn: ({ pageParam }) =>
      api.get<Paged<Post>>(`/v1/reels?limit=6${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  const reels = (q.data?.pages.flatMap((p) => pageItems<Post>(p)) ?? []).filter(
    (p) => p.media[0]?.kind === "video"
  );

  const onViewable = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    setActiveId((first?.item as Post | undefined)?.id ?? null);
  }, []);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;

  // Re-tapping the Watch tab scrolls back to the first reel.
  const listRef = useRef<FlatList<Post> | null>(null);
  useEffect(
    () => registerScrollToTop("reels", () => listRef.current?.scrollToOffset({ offset: 0, animated: true })),
    []
  );

  // Load 2 ahead: windowSize below keeps the next two pages mounted (their
  // players are created paused, so HLS starts buffering), and their poster
  // stills are warmed here so the swipe lands on a painted frame.
  const REELS_PREFETCH_AHEAD = 3;
  const prefetchedPosters = useRef(new Set<string>());
  useEffect(() => {
    const idx = activeId ? reels.findIndex((p) => p.id === activeId) : 0;
    for (const p of reels.slice(Math.max(0, idx + 1), idx + 1 + REELS_PREFETCH_AHEAD)) {
      const m = p.media[0];
      const poster = m ? posterUrl(m) || m.url : null;
      if (poster && !prefetchedPosters.current.has(poster)) {
        prefetchedPosters.current.add(poster);
        Image.prefetch(poster).catch(() => {});
      }
    }
  }, [reels, activeId]);

  if (q.isLoading) return <View style={{ flex: 1, backgroundColor: "#000" }}><Loading /></View>;
  if (q.isError && reels.length === 0) return <ErrorState onRetry={() => q.refetch()} />;
  if (reels.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <EmptyState icon="play-circle-outline" title="No reels yet" subtitle="Post a video to start the loop." />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }} onLayout={(e) => setViewH(e.nativeEvent.layout.height)}>
      <FlatList
        ref={listRef}
        data={reels}
        keyExtractor={(p) => p.id}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={viewH}
        snapToAlignment="start"
        disableIntervalMomentum
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: viewH, offset: viewH * index, index })}
        renderItem={({ item, index }) => {
          const activeIdx = activeId ? reels.findIndex((p) => p.id === activeId) : 0;
          return (
            <ReelItem
              post={item}
              active={focused && item.id === activeId}
              // 2+ reels away → rewind so scrolling back restarts the video.
              far={Math.abs(index - activeIdx) >= 2}
              muted={muted}
              onToggleMute={() => setMuted((m) => !m)}
              height={viewH}
              width={width}
            />
          );
        }}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewabilityConfig}
        // One page per viewport: windowSize 7 keeps 3 reels mounted ahead
        // (and behind) — their video players exist and buffer, paused.
        windowSize={7}
        initialNumToRender={3}
        maxToRenderPerBatch={3}
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        onEndReachedThreshold={1.5}
        style={{ backgroundColor: "#000" }}
      />
    </View>
  );
}

function ReelItem({
  post,
  active,
  far,
  muted,
  onToggleMute,
  height,
  width,
}: {
  post: Post;
  active: boolean;
  far?: boolean;
  muted: boolean;
  onToggleMute: () => void;
  height: number;
  width: number;
}) {
  const api = useApi();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [liked, setLiked] = useState(post.liked_by_me);
  const [likes, setLikes] = useState(post.like_count);

  const toggleLike = () => {
    tap();
    const now = !liked;
    setLiked(now);
    setLikes((n) => n + (now ? 1 : -1));
    const body = { subject_type: "post", subject_id: post.id };
    (now ? api.put("/v1/likes", body) : api.delWithBody("/v1/likes", body)).catch(() => {
      setLiked(!now);
      setLikes((n) => n + (now ? -1 : 1));
    });
  };

  return (
    <Pressable onPress={onToggleMute} style={{ height, width, backgroundColor: "#000" }}>
      <VideoPlayer media={post.media[0]} active={active} muted={muted} rewind={!!far} style={{ flex: 1 }} contentFit="cover" />

      {/* Right-side actions — anchored to the bottom of the video page (the
          list viewport already ends at the tab bar). */}
      <View style={{ position: "absolute", right: 12, bottom: 84, alignItems: "center", gap: 22 }}>
        <Pressable onPress={toggleLike} hitSlop={8} style={{ alignItems: "center", gap: 3 }}>
          <Ionicons name={liked ? "heart" : "heart-outline"} size={34} color={liked ? "#F04438" : "#fff"} />
          <Text style={overlayText}>{compact(likes)}</Text>
        </Pressable>
        <Pressable onPress={() => router.push(`/post/${post.id}` as never)} hitSlop={8} style={{ alignItems: "center", gap: 3 }}>
          <Ionicons name="chatbubble-outline" size={30} color="#fff" />
          <Text style={overlayText}>{compact(post.comment_count)}</Text>
        </Pressable>
        <Ionicons name={muted ? "volume-mute" : "volume-high"} size={26} color="#fff" />
      </View>

      {/* Bottom meta — sits at the very bottom of the video frame. */}
      <View style={{ position: "absolute", left: 14, right: 80, bottom: 16, gap: 8 }}>
        <Pressable
          onPress={() => router.push(`/user/${post.author.username}` as never)}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <Avatar url={post.author.avatar_url} size={34} />
          <Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>{post.author.username}</Text>
        </Pressable>
        {post.caption ? (
          <Text style={{ color: "#fff", fontSize: 13.5 }} numberOfLines={2}>
            {post.caption}
          </Text>
        ) : null}
        {post.market ? (
          <Pressable
            onPress={() => router.push(`/market/${post.market!.id}` as never)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: "rgba(0,0,0,0.55)",
              borderRadius: 12,
              paddingVertical: 8,
              paddingHorizontal: 12,
              alignSelf: "flex-start",
            }}
          >
            <Ionicons name="stats-chart" size={14} color="#307CDE" />
            <Text style={{ color: "#fff", fontSize: 12.5, fontWeight: "600", maxWidth: 220 }} numberOfLines={1}>
              {post.market.question}
            </Text>
            <Text style={{ color: "#12B76A", fontWeight: "800", fontSize: 12.5 }}>
              {post.market.yes_price_cents != null ? `${post.market.yes_price_cents}¢` : ""}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

const overlayText = { color: "#fff", fontWeight: "700" as const, fontSize: 12.5 };
