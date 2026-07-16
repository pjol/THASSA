import React, { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, Text, useWindowDimensions, View, ViewToken } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useInfiniteQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, Loading } from "../../components/states";
import { Avatar } from "../../components/ui";
import { VideoPlayer } from "../../components/VideoPlayer";
import { useApi } from "../../lib/api";
import { compact } from "../../lib/format";
import { tap } from "../../lib/haptics";
import { useTheme } from "../../lib/theme";
import { nextCursorOf, pageItems, type Paged, type Post } from "../../lib/types";

// Reels (spec §7): full-screen vertical pager of HLS videos, autoplay on the
// visible page, like/comment overlays, infinite scroll.

export default function Reels() {
  const api = useApi();
  const t = useTheme();
  const { height, width } = useWindowDimensions();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

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
    <FlatList
      data={reels}
      keyExtractor={(p) => p.id}
      pagingEnabled
      showsVerticalScrollIndicator={false}
      snapToInterval={height}
      decelerationRate="fast"
      getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
      renderItem={({ item }) => (
        <ReelItem
          post={item}
          active={item.id === activeId}
          muted={muted}
          onToggleMute={() => setMuted((m) => !m)}
          height={height}
          width={width}
        />
      )}
      onViewableItemsChanged={onViewable}
      viewabilityConfig={viewabilityConfig}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
      onEndReachedThreshold={1.5}
      style={{ backgroundColor: "#000" }}
    />
  );
}

function ReelItem({
  post,
  active,
  muted,
  onToggleMute,
  height,
  width,
}: {
  post: Post;
  active: boolean;
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
    (now ? api.put("/v1/likes", body) : api.del(`/v1/likes?subject_type=post&subject_id=${post.id}`)).catch(() => {
      setLiked(!now);
      setLikes((n) => n + (now ? -1 : 1));
    });
  };

  return (
    <Pressable onPress={onToggleMute} style={{ height, width, backgroundColor: "#000" }}>
      <VideoPlayer media={post.media[0]} active={active} muted={muted} style={{ flex: 1 }} contentFit="cover" />

      {/* Right-side actions */}
      <View style={{ position: "absolute", right: 12, bottom: insets.bottom + 110, alignItems: "center", gap: 22 }}>
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

      {/* Bottom meta */}
      <View style={{ position: "absolute", left: 14, right: 80, bottom: insets.bottom + 90, gap: 8 }}>
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
