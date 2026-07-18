import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, FlatList, Platform, Pressable, Text, View, ViewToken } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LogoRefreshList } from "../../components/LogoRefresh";
import { PostCard } from "../../components/PostCard";
import { StoriesRail } from "../../components/stories";
import { PostCardSkeleton } from "../../components/skeletons";
import { EmptyState, ErrorState, FooterLoading } from "../../components/states";
import { LogoWordmark } from "../../components/Logo";
import { Skeleton } from "../../components/ui";
import { errorMessage, useApi } from "../../lib/api";
import { tap } from "../../lib/haptics";
import { registerScrollToTop } from "../../lib/scrollToTop";
import { useSession } from "../../lib/session";
import { useTheme } from "../../lib/theme";
import { nextCursorOf, pageItems, type Paged, type Post } from "../../lib/types";

// Home feed (spec §7): stories rail + infinite-scroll feed with just-in-time
// prefetch — the next page is requested ~3 posts before the end, and media for
// upcoming posts is warmed through expo-image's disk cache.
//
// Chrome behavior: the stories rail is part of the scroll content — it scrolls
// away naturally and only comes back when you're back at the top of the feed.
// The app bar (wordmark + notifications + messages) floats above the feed and
// uses scroll direction: it slides away as you scroll down and repopulates the
// moment you start scrolling back up (Animated.diffClamp).

const PAGE = 10;

// App-bar row height, excluding the safe-area inset above it.
const APPBAR_H = 56;

export default function Home() {
  const api = useApi();
  const t = useTheme();
  // Tab screens stay mounted — videos must stop when this tab loses focus.
  const focused = useIsFocused();
  const [activePost, setActivePost] = useState<string | null>(null);

  const q = useInfiniteQuery({
    queryKey: ["feed"],
    queryFn: ({ pageParam }) =>
      api.get<Paged<Post>>(`/v1/feed?limit=${PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  const posts = q.data?.pages.flatMap((p) => pageItems<Post>(p)) ?? [];

  // Look-ahead prefetch: warm media for the NEXT 4 posts past the one on
  // screen (not the whole loaded list — that pins every page's media in
  // memory). Re-runs as the active post advances, staying 4 ahead.
  const FEED_PREFETCH_AHEAD = 4;
  const prefetched = useRef(new Set<string>());
  useEffect(() => {
    const activeIdx = activePost ? posts.findIndex((p) => p.id === activePost) : 0;
    const ahead = posts.slice(Math.max(0, activeIdx + 1), activeIdx + 1 + FEED_PREFETCH_AHEAD);
    const urls: string[] = [];
    for (const p of ahead) {
      for (const m of p.media) {
        if (m.kind === "image" && m.url && !prefetched.current.has(m.url)) {
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
  }, [posts, activePost]);

  // Track the most-visible post so only its video plays — and only while more
  // than half of the post is actually on screen.
  const onViewable = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    setActivePost((first?.item as Post | undefined)?.id ?? null);
  }, []);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 51 }).current;

  // Direction-aware floating app bar. Deliberately NOT scroll-coupled: per-
  // frame coupling (diffClamp) flickers with jittery web/momentum scroll
  // events. Instead the bar has two discrete states (shown/hidden) driven by
  // scroll DIRECTION with a small hysteresis threshold, and a single timing
  // animation between them — scrolling up (any amount past the threshold)
  // brings it back; near the top it is always shown.
  const insets = useSafeAreaInsets();
  const headerH = APPBAR_H + insets.top;
  const barAnim = useRef(new Animated.Value(0)).current; // 0 = shown, 1 = hidden
  const barHidden = useRef(false);
  const lastY = useRef(0);
  const setBarHidden = useCallback(
    (hide: boolean) => {
      if (barHidden.current === hide) return;
      barHidden.current = hide;
      Animated.timing(barAnim, {
        toValue: hide ? 1 : 0,
        duration: 220,
        useNativeDriver: true,
      }).start();
    },
    [barAnim]
  );
  const onScrollChrome = useCallback(
    (y: number) => {
      const dy = y - lastY.current;
      lastY.current = y;
      if (y <= headerH) {
        setBarHidden(false); // at/near the top the bar is always present
        return;
      }
      if (dy > 6) setBarHidden(true);
      else if (dy < -6) setBarHidden(false);
      // |dy| ≤ 6: jitter — leave the bar alone.
    },
    [headerH, setBarHidden]
  );
  const headerTranslate = barAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -headerH] });

  // Tap the app bar (the very top of the screen) — or re-tap the Home tab —
  // to scroll back to the top.
  const listRef = useRef<FlatList<Post> | null>(null);
  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setBarHidden(false);
  }, [setBarHidden]);
  useEffect(() => registerScrollToTop("index", scrollToTop), [scrollToTop]);

  if (q.isLoading) return <FeedSkeleton />;
  if (q.isError && posts.length === 0) {
    return <ErrorState onRetry={() => q.refetch()} subtitle={errorMessage(q.error)} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <LogoRefreshList<Post>
        ref={listRef}
        refreshing={q.isRefetching && !q.isFetchingNextPage}
        onRefresh={() => q.refetch()}
        topOffset={headerH - 8}
        data={posts}
        keyExtractor={(p: Post) => p.id}
        renderItem={({ item, index }: { item: Post; index: number }) => {
          const activeIdx = activePost ? posts.findIndex((p) => p.id === activePost) : 0;
          return (
            <PostCard
              post={item}
              active={focused && item.id === activePost}
              // 2+ posts away → videos rewind so scrolling back restarts them.
              farFromActive={Math.abs(index - activeIdx) >= 2}
            />
          );
        }}
        // Just-in-time pagination: with ~1.2-screen-tall posts, 0.55×PAGE/3 ≈
        // triggers ~3 posts before the end of the loaded list.
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        onEndReachedThreshold={3 / PAGE + 0.2}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewabilityConfig}
        onScroll={(e) => onScrollChrome(e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={16}
        // Keep memory + update cost bounded: render a small window around the
        // viewport and mount off-screen rows lazily (PostCard rows are
        // memoized; media loads through expo-image's disk cache).
        windowSize={7}
        maxToRenderPerBatch={4}
        initialNumToRender={4}
        updateCellsBatchingPeriod={60}
        removeClippedSubviews={Platform.OS !== "web"}
        // The stories rail scrolls away with the content — it lives at the top
        // of the feed, not in the floating chrome.
        ListHeaderComponent={<StoriesRail />}
        ListEmptyComponent={
          <EmptyState
            icon="planet-outline"
            title="Your feed is empty"
            subtitle="Follow people from Explore to fill it up."
          />
        }
        ListFooterComponent={q.isFetchingNextPage ? <FooterLoading /> : <View style={{ height: 24 }} />}
        contentContainerStyle={[
          // Slightly less than the bar height so the stories rail sits snug
          // under the app bar instead of floating below it.
          { paddingTop: headerH - 8 },
          posts.length === 0 ? { flexGrow: 1 } : null,
        ]}
        showsVerticalScrollIndicator={false}
      />

      {/* Floating app bar: wordmark + notifications + messages. Tapping the
          bar itself (social-media convention: tap the very top of the screen)
          scrolls the feed back to the top. */}
      <Animated.View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: headerH,
          paddingTop: insets.top,
          backgroundColor: t.bg,
          transform: [{ translateY: headerTranslate }],
          zIndex: 10,
        }}
      >
        <Pressable
          onPress={scrollToTop}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 14,
          }}
        >
          <LogoWordmark size={26} markColor={t.blue} />
          <HeaderActions />
        </Pressable>
      </Animated.View>
    </View>
  );
}

// Notifications bell + DM bubbles, both with unread badges.
function HeaderActions() {
  const t = useTheme();
  const { unreadNotifications, unreadMessages } = useSession();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>
      <Link href="/notifications" asChild>
        <Pressable hitSlop={8} onPress={tap}>
          <Ionicons name="notifications-outline" size={26} color={t.text} />
          {unreadNotifications > 0 ? <HeaderBadge count={unreadNotifications} /> : null}
        </Pressable>
      </Link>
      <Link href="/messages" asChild>
        <Pressable hitSlop={8} onPress={tap}>
          <Ionicons name="chatbubble-ellipses-outline" size={25} color={t.text} />
          {unreadMessages > 0 ? <HeaderBadge count={unreadMessages} /> : null}
        </Pressable>
      </Link>
    </View>
  );
}

function HeaderBadge({ count }: { count: number }) {
  const t = useTheme();
  return (
    <View
      style={{
        position: "absolute",
        top: -4,
        right: -8,
        backgroundColor: t.no,
        minWidth: 17,
        height: 17,
        borderRadius: 9,
        borderWidth: 1.5,
        borderColor: t.bg,
        paddingHorizontal: 3,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>{count > 9 ? "9+" : count}</Text>
    </View>
  );
}

// First-load skeleton: stories rail circles + a few post-shaped cards.
function FeedSkeleton() {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: 14, gap: 18 }}>
      <View style={{ flexDirection: "row", gap: 14, paddingHorizontal: 14 }}>
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} style={{ width: 58, height: 58, borderRadius: 29 }} />
        ))}
      </View>
      {[0, 1, 2].map((i) => (
        <PostCardSkeleton key={i} />
      ))}
    </View>
  );
}
