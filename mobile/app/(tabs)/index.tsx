import React, { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, View, ViewToken } from "react-native";
import { Image } from "expo-image";
import { useInfiniteQuery } from "@tanstack/react-query";
import { PostCard } from "../../components/PostCard";
import { StoriesRail } from "../../components/stories";
import { EmptyState, ErrorState, Loading } from "../../components/states";
import { Skeleton } from "../../components/ui";
import { errorMessage, useApi } from "../../lib/api";
import { useTheme } from "../../lib/theme";
import { nextCursorOf, pageItems, type Paged, type Post } from "../../lib/types";

// Home feed (spec §7): stories rail + infinite-scroll feed with just-in-time
// prefetch — the next page is requested ~3 posts before the end, and media for
// upcoming posts is warmed through expo-image's disk cache.

const PAGE = 10;

export default function Home() {
  const api = useApi();
  const t = useTheme();
  const [activePost, setActivePost] = useState<string | null>(null);

  const q = useInfiniteQuery({
    queryKey: ["feed"],
    queryFn: ({ pageParam }) =>
      api.get<Paged<Post>>(`/v1/feed?limit=${PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  const posts = q.data?.pages.flatMap((p) => pageItems<Post>(p)) ?? [];

  // Prefetch media for the posts just below the fold whenever new data lands.
  const prefetched = useRef(new Set<string>());
  useEffect(() => {
    const urls: string[] = [];
    for (const p of posts) {
      for (const m of p.media) {
        if (m.kind === "image" && !prefetched.current.has(m.url)) {
          prefetched.current.add(m.url);
          urls.push(m.url);
        }
      }
      if (p.author.avatar_url && !prefetched.current.has(p.author.avatar_url)) {
        prefetched.current.add(p.author.avatar_url);
        urls.push(p.author.avatar_url);
      }
    }
    if (urls.length) Image.prefetch(urls).catch(() => {});
  }, [posts]);

  // Track the most-visible post so only its video plays.
  const onViewable = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    setActivePost((first?.item as Post | undefined)?.id ?? null);
  }, []);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 55 }).current;

  if (q.isLoading) return <FeedSkeleton />;
  if (q.isError && posts.length === 0) {
    return <ErrorState onRetry={() => q.refetch()} subtitle={errorMessage(q.error)} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={posts}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={<StoriesRail />}
        renderItem={({ item }) => <PostCard post={item} active={item.id === activePost} />}
        // Just-in-time pagination: with ~1.2-screen-tall posts, 0.55×PAGE/3 ≈
        // triggers ~3 posts before the end of the loaded list.
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        onEndReachedThreshold={3 / PAGE + 0.2}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewabilityConfig}
        refreshing={q.isRefetching && !q.isFetchingNextPage}
        onRefresh={() => q.refetch()}
        ListEmptyComponent={
          <EmptyState
            icon="planet-outline"
            title="Your feed is empty"
            subtitle="Follow people from Explore to fill it up."
          />
        }
        ListFooterComponent={q.isFetchingNextPage ? <Loading /> : <View style={{ height: 24 }} />}
        contentContainerStyle={posts.length === 0 ? { flexGrow: 1 } : undefined}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

function FeedSkeleton() {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 14, gap: 18 }}>
      <View style={{ flexDirection: "row", gap: 14 }}>
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} style={{ width: 58, height: 58, borderRadius: 29 }} />
        ))}
      </View>
      {[0, 1].map((i) => (
        <View key={i} style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Skeleton style={{ width: 36, height: 36, borderRadius: 18 }} />
            <Skeleton style={{ width: 120, height: 14 }} />
          </View>
          <Skeleton style={{ width: "100%", height: 320 }} />
          <Skeleton style={{ width: "70%", height: 12 }} />
        </View>
      ))}
    </View>
  );
}
